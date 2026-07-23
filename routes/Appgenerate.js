// routes/appGenerate.js
import express from 'express'
import crypto from 'crypto'
import Anthropic from '@anthropic-ai/sdk'
import Groq from 'groq-sdk'

import { query, queryOne } from '../config/db.js'
import { authMiddleware } from './auth.js'
import { platformGuard } from './platformGuard.js'
// add near top imports
import { detectPromptType } from '../utils/intentGuard.js'
import { modeGuard } from '../middleware/modeGuard.js'

const router = express.Router()
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })

const APP_GEN_CREDITS = 200
const APP_GEN_MODEL   = 'claude-opus-4-8'
const GROQ_MODEL      = 'llama-3.3-70b-versatile'

// ─── SYSTEM PROMPT ───────────────────────────────────────────────────────────
const SYSTEM_PROMPT = `You are an expert full-stack developer specializing in complete, production-ready web applications.
The user will describe a web application. You will generate a COMPLETE, self-contained, single-file HTML app.

═══════════════════════════════════════════════
ABSOLUTE OUTPUT RULES (never break these):
═══════════════════════════════════════════════
1. Return ONLY raw HTML. Start IMMEDIATELY with <!DOCTYPE html>
2. Do NOT include: markdown fences (\`\`\`), explanations, preamble, or any text outside the HTML
3. The file MUST end with </html> — never truncate mid-file
4. Minimum output: 400 lines of HTML

═══════════════════════════════════════════════
REQUIRED SECTIONS (include ALL of these):
═══════════════════════════════════════════════
✓ <head> with meta viewport, title, and all <style> CSS
✓ Sidebar navigation with icons and collapsible mobile hamburger
✓ Top header bar: app logo/name, search bar, notification bell, user avatar + dropdown
✓ Dashboard home view: 4 KPI stat cards, a chart (CSS/JS drawn), recent activity feed
✓ Main data table view: columns, sortable headers, pagination, search/filter bar
✓ CRUD modals: Add/Edit form modal, Delete confirmation modal
✓ Status badges (active/inactive/pending in different colors)
✓ Empty state illustration (shown when no data)
✓ Toast/snackbar notification system (success, error, warning)
✓ Bottom status bar: record count + last updated timestamp
✓ Responsive mobile layout (hamburger collapses sidebar)
✓ All JS in a single <script> tag at bottom of <body>

═══════════════════════════════════════════════
DATA REQUIREMENTS:
═══════════════════════════════════════════════
- Pre-populate with 8-12 realistic sample records relevant to the app type
- Persist ALL data in localStorage under key: "zws_<apptype>_data"
- Load from localStorage on startup, fall back to sample data if empty
- All CRUD operations must update localStorage immediately

═══════════════════════════════════════════════
DESIGN REQUIREMENTS:
═══════════════════════════════════════════════
- Dark theme: background #0f1117, sidebar #1a1d27, cards #1e2130, accent #6c63ff
- All CSS must be inline in <style> — no external CDN
- Smooth transitions on all interactive elements (0.2s ease)
- Hover states, focus rings, active states on every clickable element
- Professional SaaS dashboard aesthetic (think Vercel / Linear / Notion dark mode)
- Mobile-first responsive breakpoints at 768px

═══════════════════════════════════════════════
JS REQUIREMENTS:
═══════════════════════════════════════════════
- Vanilla JS only — no external libraries
- Modular code with clear function names (renderTable, openModal, saveRecord, etc.)
- All event listeners set up in a single init() function called on DOMContentLoaded
- Error handling on all localStorage operations (try/catch)
- Debounced search input (300ms delay)

Begin your response NOW with <!DOCTYPE html> and do not stop until </html> is written.`

// ─── HELPERS ─────────────────────────────────────────────────────────────────

/**
 * Strip any accidental preamble/postamble around the HTML.
 * Finds the first valid HTML start tag and last </html>.
 */
function extractCleanHtml(rawText) {
  if (!rawText) return ''

  // Find earliest valid HTML start
  const doctypeIdx = rawText.indexOf('<!DOCTYPE')
  const htmlIdx    = rawText.indexOf('<html')
  let startIdx = -1

  if (doctypeIdx !== -1 && (htmlIdx === -1 || doctypeIdx < htmlIdx)) {
    startIdx = doctypeIdx
  } else if (htmlIdx !== -1) {
    startIdx = htmlIdx
  }

  if (startIdx === -1) return rawText // can't locate HTML — return as-is

  let html = rawText.slice(startIdx)

  // Trim anything after the last </html>
  const endIdx = html.lastIndexOf('</html>')
  if (endIdx !== -1) {
    html = html.slice(0, endIdx + 7)
  }

  // Strip any stray markdown fences
  html = html.replace(/^```html?\n?/im, '').replace(/\n?```$/im, '').trim()

  return html
}

/**
 * Validate the generated HTML meets minimum quality requirements.
 * FIX: Raised line count minimum from 100 to 300 (matching 400-line prompt requirement).
 */
function validateHtml(html) {
  if (!html || html.trim().length === 0) {
    return { valid: false, reason: 'Empty output from AI' }
  }

  const hasDoctype = html.includes('<!DOCTYPE') || html.includes('<html')
  const hasClose   = html.includes('</html>')
  const hasStyle   = html.includes('<style')
  const hasScript  = html.includes('<script')
  const lineCount  = html.split('\n').length

  if (!hasDoctype) return { valid: false, reason: 'Missing HTML structure (no <!DOCTYPE> or <html>)' }
  if (!hasClose)   return { valid: false, reason: 'HTML was truncated — no closing </html> found' }
  if (!hasStyle)   return { valid: false, reason: 'Missing <style> block — CSS was not generated' }
  if (!hasScript)  return { valid: false, reason: 'Missing <script> block — no interactivity generated' }

  // FIX: Was 100, now 300 to match the 400-line prompt requirement
  if (lineCount < 300) {
    return { valid: false, reason: `Output too short (${lineCount} lines) — likely incomplete or truncated` }
  }

  return { valid: true }
}

/**
 * Attempt to complete a truncated HTML file.
 * FIX: Finds the last complete HTML tag to avoid broken stitching at join point.
 */
async function continueGeneration(truncatedHtml) {
  console.log('Attempting continuation for truncated output...')

  // FIX: Find the last complete closing > tag to avoid broken stitching
  const lastCompleteTagEnd = truncatedHtml.lastIndexOf('>')
  const safeBase = lastCompleteTagEnd !== -1
    ? truncatedHtml.slice(0, lastCompleteTagEnd + 1)
    : truncatedHtml

  // Send only the last 3000 chars as context to save tokens
  const tail = safeBase.slice(-3000)

  try {
    const message = await anthropic.messages.create({
      model:      APP_GEN_MODEL,
      max_tokens: 8192,
      system: `You are completing a truncated HTML file.
The user will give you the END of an incomplete HTML file.
Continue EXACTLY from where it cut off and write until </html>.
Return ONLY the continuation HTML — no preamble, no explanation, no markdown.
Start from wherever the file was cut and end with </html>.`,
      messages: [{
        role:    'user',
        content: `This HTML file was cut off. Here is where it ended:\n\n...${tail}\n\nContinue and complete the file, ending with </html>.`
      }]
    })

    const continuation = message.content?.[0]?.text || ''

    // FIX: Stitch at the safe base point (last complete tag), not raw truncated output
    return safeBase + continuation

  } catch (err) {
    console.error('Continuation request failed:', err.message)
    return truncatedHtml // return what we have — validateHtml will catch it
  }
}

// ─── GENERATE ────────────────────────────────────────────────────────────────
router.post('/generate', authMiddleware, platformGuard, modeGuard('app'), async (req, res) => {
  const { prompt, provider, logoBase64, logoMediaType } = req.body
  const userId = req.user.id

  if (!prompt?.trim()) {
    return res.status(400).json({ error: 'prompt is required' })
  }

  // Check credits BEFORE doing anything
  const user = await queryOne('SELECT credits FROM users WHERE id = ?', [userId])
  if (!user || user.credits < APP_GEN_CREDITS) {
    return res.status(402).json({ error: 'Insufficient credits. Please purchase more to continue.' })
  }

  // Block concurrent generations
  const inProgress = await queryOne(
    `SELECT id FROM apps WHERE user_id = ? AND status = 'generating'`,
    [userId]
  )
  if (inProgress) {
    return res.status(429).json({ error: 'You already have an app generating. Please wait for it to finish.' })
  }

  const appId = crypto.randomUUID()
  const title = prompt.trim().slice(0, 80)

  // Insert DB rows with 'generating' status — credits NOT deducted yet
  try {
    await query(
      `INSERT INTO apps (id, user_id, title, prompt, status, created_at) VALUES (?, ?, ?, ?, 'generating', NOW())`,
      [appId, userId, title, prompt.trim()]
    )
    await query(
      `INSERT INTO projects (id, user_id, title, prompt, status, created_at) VALUES (?, ?, ?, ?, 'generating', NOW())`,
      [appId, userId, title, prompt.trim()]
    )
  } catch (dbErr) {
    console.error(`[${appId}] DB insert failed:`, dbErr.message)
    return res.status(500).json({ error: 'Failed to initialize generation. Please try again.' })
  }

  try {
    let rawOutput = ''

    // ── GROQ PATH ──────────────────────────────────────────────────────────
    if (provider === 'groq') {
      const groqKey = process.env.GROQ_API_KEY
      console.log(`[${appId}] Using Groq (${GROQ_MODEL}):`, groqKey ? 'key found' : 'key MISSING')

      const groqClient = new Groq({ apiKey: groqKey })
      const completion = await groqClient.chat.completions.create({
        model:      GROQ_MODEL,
        max_tokens: 8000,
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user',   content: `Build this complete web app: ${prompt.trim()}` }
        ],
      })

      rawOutput = completion.choices?.[0]?.message?.content || ''

      // FIX: Groq truncation check (was missing before)
      const finishReason = completion.choices?.[0]?.finish_reason
      if (finishReason === 'length') {
        console.warn(`[${appId}] Groq output truncated (finish_reason: length) — attempting continuation`)
        const stitched = await continueGenerationGroq(groqClient, rawOutput)
        rawOutput = stitched
      }
    }

    // ── CLAUDE PATH ────────────────────────────────────────────────────────
    else {
      console.log(`[${appId}] Using Claude (${APP_GEN_MODEL}) — "${title}"`)
const userContent = []

      if (logoBase64 && logoMediaType) {
        const allowedLogoTypes = ['image/png', 'image/jpeg', 'image/webp']
        if (allowedLogoTypes.includes(logoMediaType)) {
          userContent.push({
            type: 'image',
            source: { type: 'base64', media_type: logoMediaType, data: logoBase64 },
          })
        }
      }

      userContent.push({
        type: 'text',
        text: `Build this complete web app: ${prompt.trim()}${
          logoBase64 ? '\n\nA logo image is attached. Use it in the sidebar/header as the app logo, and pick the accent color from its dominant colors instead of the default #6c63ff.' : ''
        }

Remember: Output ONLY the complete HTML file from <!DOCTYPE html> to </html>. No text before or after.`
      })

      const message = await anthropic.messages.create({
        model:       APP_GEN_MODEL,
        max_tokens:  30000,
        system:      SYSTEM_PROMPT,
        messages: [{ role: 'user', content: userContent }]
      })
     

      rawOutput = message.content?.[0]?.text || ''

      // Handle truncation: attempt continuation
      if (message.stop_reason === 'max_tokens') {
        console.warn(`[${appId}] Claude truncated at max_tokens — attempting continuation`)
        rawOutput = await continueGeneration(rawOutput)
      }
    }

    // ── Clean and validate ─────────────────────────────────────────────────
    const generatedHtml = extractCleanHtml(rawOutput)
    const validation    = validateHtml(generatedHtml)

    if (!validation.valid) {
      console.error(`[${appId}] Validation failed: ${validation.reason}`)
      await query(`UPDATE apps     SET status = 'failed', updated_at = NOW() WHERE id = ?`, [appId])
      await query(`UPDATE projects SET status = 'failed', updated_at = NOW() WHERE id = ?`, [appId])
      // Credits NOT deducted on failure
      return res.status(500).json({
        error: `Generation failed: ${validation.reason}. Credits were not deducted — please try again.`
      })
    }

    // ── SUCCESS: save HTML + deduct credits ────────────────────────────────
    await query(
      `UPDATE apps     SET generated_html = ?, status = 'ready', updated_at = NOW() WHERE id = ?`,
      [generatedHtml, appId]
    )
    await query(
      `UPDATE projects SET generated_html = ?, status = 'ready', updated_at = NOW() WHERE id = ?`,
      [generatedHtml, appId]
    )

    // Deduct ONLY after confirmed success
    await query('UPDATE users SET credits = credits - ? WHERE id = ?', [APP_GEN_CREDITS, userId])
    const updatedUser = await queryOne('SELECT credits FROM users WHERE id = ?', [userId])

    const lineCount = generatedHtml.split('\n').length
    console.log(`✅ [${appId}] Success — ${lineCount} lines generated`)

    return res.json({
      success:          true,
      appId,
      title,
      generatedHtml,
      creditsUsed:      APP_GEN_CREDITS,
      creditsRemaining: updatedUser?.credits ?? 0,
    })

  } catch (err) {
    // Any thrown error — mark failed, do NOT deduct credits
    await query(`UPDATE apps     SET status = 'failed', updated_at = NOW() WHERE id = ?`, [appId])
    await query(`UPDATE projects SET status = 'failed', updated_at = NOW() WHERE id = ?`, [appId])
    console.error(`[${appId}] Generation error:`, err.message)
    return res.status(500).json({
      error: `Generation failed. Credits were not deducted. ${err.message}`
    })
  }
})

/**
 * Groq-specific continuation (uses Groq client, not Anthropic).
 * Separated from continueGeneration() to keep providers clean.
 */
async function continueGenerationGroq(groqClient, truncatedHtml) {
  console.log('Attempting Groq continuation...')

  const lastCompleteTagEnd = truncatedHtml.lastIndexOf('>')
  const safeBase = lastCompleteTagEnd !== -1
    ? truncatedHtml.slice(0, lastCompleteTagEnd + 1)
    : truncatedHtml

  const tail = safeBase.slice(-3000)

  try {
    const completion = await groqClient.chat.completions.create({
      model:      GROQ_MODEL,
      max_tokens: 4000,
      messages: [
        {
          role:    'system',
          content: `You are completing a truncated HTML file. Continue from where it cut off and write until </html>. Return only the continuation HTML.`
        },
        {
          role:    'user',
          content: `HTML cut off here:\n\n...${tail}\n\nContinue and end with </html>.`
        }
      ],
    })

    const continuation = completion.choices?.[0]?.message?.content || ''
    return safeBase + continuation
  } catch (err) {
    console.error('Groq continuation failed:', err.message)
    return truncatedHtml
  }
}

// ─── CUSTOMIZE ───────────────────────────────────────────────────────────────
router.post('/customize', authMiddleware, async (req, res) => {
  const { html, changes, appId } = req.body

  if (!html || !changes?.trim()) {
    return res.status(400).json({ error: 'html and changes are required' })
  }

  // FIX: Strip <style> block to save tokens while keeping JS logic intact.
  // The CSS is the largest section and usually irrelevant to functional changes.
  const htmlForContext = (() => {
    if (html.length <= 50000) return html

    // Try to strip only the <style> block to save tokens
    const styleStripped = html.replace(
      /<style[\s\S]*?<\/style>/i,
      '<style>/* Existing CSS preserved — do not regenerate it */</style>'
    )

    // If that's still too large, fall back to head+tail slicing
    if (styleStripped.length > 60000) {
      return styleStripped.slice(0, 25000)
        + '\n\n<!-- ... middle section omitted — preserve all existing JS logic ... -->\n\n'
        + styleStripped.slice(-25000)
    }

    return styleStripped
  })()

  try {
    const message = await anthropic.messages.create({
      model:       APP_GEN_MODEL,
      max_tokens:  30000,
     
      system: `You are an expert web developer making targeted edits to an existing HTML app.

RULES:
1. Apply ONLY the requested changes — do not restructure or rewrite unrelated sections
2. Return the COMPLETE updated HTML from <!DOCTYPE html> to </html>
3. No explanation, no markdown fences, no text outside the HTML
4. Preserve all existing functionality — only modify what was asked
5. Keep all existing localStorage keys and data structures intact
6. Do not regenerate or change any CSS that was not mentioned in the changes request`,
      messages: [{
        role:    'user',
        content: `Here is the current app HTML:\n\n${htmlForContext}\n\nMake these changes:\n${changes.trim()}\n\nReturn only the complete updated HTML from <!DOCTYPE html> to </html>.`
      }],
    })

    const rawUpdated  = message.content?.[0]?.text || ''
    const updatedHtml = extractCleanHtml(rawUpdated)
    const validation  = validateHtml(updatedHtml)

    if (!validation.valid) {
      return res.status(500).json({
        error: `Customization produced invalid output: ${validation.reason}`
      })
    }

    // Save updated HTML back to DB if appId was provided
    if (appId) {
      await query(
        `UPDATE apps SET generated_html = ?, updated_at = NOW() WHERE id = ?`,
        [updatedHtml, appId]
      ).catch(err => console.warn(`[${appId}] Could not save customized HTML:`, err.message))
    }

    return res.json({ success: true, html: updatedHtml })

  } catch (err) {
    console.error('Customize error:', err.message)
    return res.status(500).json({ error: 'Customization failed: ' + err.message })
  }
})

// ─── REGENERATE SECTION ──────────────────────────────────────────────────────
// Regenerate just one section of an existing app — cheaper than full regen.
router.post('/regenerate-section', authMiddleware, async (req, res) => {
  const { html, section, instruction } = req.body

  if (!html || !section || !instruction?.trim()) {
    return res.status(400).json({ error: 'html, section, and instruction are required' })
  }

  // Only send the first 30k chars for section context (section is part of it)
  const htmlContext = html.length > 30000
    ? html.slice(0, 30000) + '\n<!-- rest of app omitted -->'
    : html

  try {
    const message = await anthropic.messages.create({
      model:       APP_GEN_MODEL,
      max_tokens:  30000,
      
      system: `You are an expert web developer improving a specific section of an HTML app.
Return ONLY the improved HTML snippet for that section — not the full file.
No explanation, no markdown fences, no text outside the HTML snippet.`,
      messages: [{
        role:    'user',
        content: `In this app:\n\n${htmlContext}\n\nImprove the "${section}" section with this instruction:\n${instruction.trim()}\n\nReturn only the improved HTML snippet for that section.`
      }],
    })

    const sectionHtml = message.content?.[0]?.text || ''

    if (!sectionHtml.trim()) {
      return res.status(500).json({ error: 'AI returned empty section — please try again.' })
    }

    return res.json({ success: true, sectionHtml })

  } catch (err) {
    console.error('Section regen error:', err.message)
    return res.status(500).json({ error: 'Section regeneration failed: ' + err.message })
  }
})

export default router