
import Anthropic from '@anthropic-ai/sdk'
import { v4 as uuidv4 } from 'uuid'
import { query, queryOne } from '../config/db.js'
import { deductAfterSuccess } from '../middleware/creditsCheck.js'
import { injectTrackingScript } from './analyticsController.js'
import { sendUnpaidProjectEmail, sendZeroCreditsEmail } from '../utils/mailer.js'
const errText = (err) => {
  const apiMsg = err?.error?.error?.message   // Anthropic SDK error body
  return `${err?.status ? `[${err.status}] ` : ''}${apiMsg || err?.message || 'Unknown error'}`.slice(0, 1000)
}
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })
// middleware/creditsCheck.js
export const WEBSITE_GEN_CREDITS = 100 // or whatever the actual cost is
const AI_PROMPT = `You are Zater AI Studio's expert website generator. Generate complete, stunning, single-file HTML websites.
STRICT RULES:
- Return ONLY raw HTML. No markdown, no backticks, no explanation text.
- Start with <!DOCTYPE html> and end with </html>.
- Embed ALL styles in <style> inside <head>.
- Embed ALL JavaScript in <script> before </body>.
- Use modern CSS: flexbox, grid, CSS variables, animations, gradients.
- Import Google Fonts via @import in the <style> tag.
- Fully responsive — mobile first.
- Smooth scroll, hover effects, entrance animations.
- Realistic professional placeholder content.
- Sticky navigation, hero, features, about, contact sections.
- DO NOT use <a> anchor tags anywhere — for the nav bar, buttons, links, or CTAs. Use <button> elements for ALL clickable items (nav links, CTAs, footer links included), with onclick or JS event listeners handling scroll/navigation via document.getElementById(...).scrollIntoView().

IMAGES — INLINE SVG ILLUSTRATIONS ONLY:
- DO NOT use external image URLs, <img src="http...">, <image href="http...">, or CSS url(http...). Every visual is inline <svg> or a CSS gradient.
- Hero: one large, detailed SVG illustration that matches the topic. For food, draw a plate or bowl seen from above with shapes for the rice, toppings, garnish, steam and a table or cloth background. For other topics, draw a scene that fits (devices, charts, buildings, landscapes, tools).
- Repeated items (menu dishes, products, team, gallery, testimonials): do NOT hand-write a separate SVG for each item. Write ONE JavaScript function, for example drawDish(rice, accent, topping, i), that returns an SVG string, and call it for every item in the JS data array. Insert the result with innerHTML.
- Make each item look different by changing colors (rice color, sauce color, background tint) and toppings (lemon slices, peas, cashews, coriander leaves, tomato pieces, carrot shreds).
- Features/services: a unique inline SVG icon for each card.
- Team/avatars: simple geometric faces or shapes, no photos.
- Decorative: a SVG logo in the nav, wave or curve section dividers, blob backgrounds.
- Use <linearGradient> and <radialGradient> for shading, an <ellipse> shadow under plates, and highlight shapes for depth.
- Every <svg> must have a viewBox, no fixed width or height attributes, and be sized with CSS (width:100%; height:auto). Put each one in a container with a gradient background.
- Color SVGs with CSS variables or currentColor so they match the site theme.
- Give every gradient, clipPath and filter a UNIQUE id. For SVGs created in a loop, add the item index to each id (for example "g" + i) so they never collide.
- Add role="img" with a <title> to meaningful illustrations, and aria-hidden="true" to decorative ones.
- Animate subtly with CSS (steam rising, floating, gentle rotation) and respect prefers-reduced-motion.
- Keep every SVG compact: simple shapes, no huge path data.`

export const WEBSITE_EDIT_CREDITS = 100

const EDIT_RULES = `
EDIT MODE: You will receive an existing website's full HTML and a change request.
- Apply ONLY the requested change. Keep every other section, style and script exactly as is.
- Return the COMPLETE updated HTML (<!DOCTYPE html> ... </html>), raw, no markdown, no explanation.
- Keep the same rules: no <a> tags (use <button>), no external image URLs.
- Any new image must be an inline <svg> with a viewBox, themed with CSS variables, and unique gradient and clipPath ids that do not clash with existing ones. If the page already has an SVG drawing function, reuse it instead of writing new SVGs.`
const editWithAI = async (currentHtml, instruction) => {
  let html = ''
  const stream = anthropic.messages.stream({
    model: 'claude-opus-4-8',
    max_tokens: 52000,
    system: AI_PROMPT + EDIT_RULES,
    messages: [{
      role: 'user',
      content: `CURRENT HTML:\n${currentHtml}\n\nCHANGE REQUEST: ${instruction}`,
    }],
  })
  for await (const chunk of stream) {
    if (chunk.type === 'content_block_delta' && chunk.delta?.type === 'text_delta') html += chunk.delta.text
  }
  const result = await stream.finalMessage()
  // A truncated page would corrupt the project, so fail instead of saving it
  if (result.stop_reason === 'max_tokens') throw new Error('Edit output truncated')
  return html
}

const editWebsite = async (projectId, userId, currentHtml, instruction) => {
  try {
    const last = await queryOne(
      'SELECT COALESCE(MAX(version_no),0) AS v FROM project_versions WHERE project_id=?', [projectId])
    let versionNo = last.v

    // Snapshot the original once so the user can always go back
    if (versionNo === 0) {
      await query(
        `INSERT INTO project_versions (id, project_id, version_no, html, prompt, credits_used)
         VALUES (?,?,?,?,?,0)`,
        [uuidv4(), projectId, 1, currentHtml, 'Initial version']
      )
      versionNo = 1
    }

    const raw = await editWithAI(currentHtml, instruction)
    const html = raw.replace(/^```html?\n?/i, '').replace(/\n?```$/i, '').trim()
    if (html.length < 100 || !/<\/html>\s*$/i.test(html)) throw new Error('Invalid edited HTML')

    // Avoid injecting the tracker twice if Claude kept the existing one
    const finalHtml = html.includes(projectId) ? html : injectTrackingScript(html, projectId)

    await query(
      `UPDATE projects SET generated_html=?, status='ready', current_step=NULL, edit_error=NULL, updated_at=NOW() WHERE id=?`,
      [finalHtml, projectId]
    )
    await query(
      `INSERT INTO project_versions (id, project_id, version_no, html, prompt, credits_used)
       VALUES (?,?,?,?,?,?)`,
      [uuidv4(), projectId, versionNo + 1, finalHtml, instruction, WEBSITE_EDIT_CREDITS]
    )
    await deductAfterSuccess(userId, WEBSITE_EDIT_CREDITS, 'website_edit')
       
    console.log(`✏️ Edited ${projectId} → v${versionNo + 1}`)
  } catch (err) {
    // Keep the old HTML, release the lock, no charge
    await query(
      `UPDATE projects SET status='ready', current_step=NULL, edit_error=? WHERE id=?`,
      ['Edit failed. You were not charged. Please try again.', projectId]
    )
    console.error(`❌ Edit failed ${projectId}:`, err.message, err.sqlMessage || '', err.status || '')
  }
}
// ── GET /api/projects/:id/versions/:versionNo ─────────────────
export const getVersionHtml = async (req, res) => {
  try {
    const p = await queryOne('SELECT id FROM projects WHERE id=? AND user_id=?', [req.params.id, req.user.id])
    if (!p) return res.status(404).json({ error: 'Not found.' })
    const v = await queryOne(
  'SELECT version_no, prompt, html, github_url FROM project_versions WHERE project_id=? AND version_no=?',
  [p.id, req.params.versionNo])
    if (!v) return res.status(404).json({ error: 'Version not found.' })
    res.json({ version: v })
  } catch { res.status(500).json({ error: 'Failed to fetch version.' }) }
}
// ── POST /api/projects/:id/edit/questions (free, no lock) ─────
export const getEditQuestions = async (req, res) => {
  try {
    const instruction = req.body?.prompt?.trim()
    if (!instruction || instruction.length < 3 || instruction.length > 2000)
      return res.status(400).json({ error: 'Describe your change in 3–2000 characters.' })

    const p = await queryOne(
      'SELECT id, prompt, status FROM projects WHERE id=? AND user_id=? AND deleted_at IS NULL',
      [req.params.id, req.user.id]
    )
    if (!p) return res.status(404).json({ error: 'Project not found.' })
    if (p.status !== 'ready') return res.status(409).json({ error: 'Project is not ready to edit.' })

    if (!(await hasEditCredits(req.user.id, res))) return

    const questions = await generateEditQuestions(p.prompt, instruction)
    res.json({ questions })
  } catch (err) {
    console.error('getEditQuestions:', err.message)
    res.json({ questions: [] })   // fail open: the edit just runs without questions
  }
}
// ── POST /api/projects/:id/edit ───────────────────────────────
// ── POST /api/projects/:id/edit ───────────────────────────────
export const editProject = async (req, res) => {
  try {
    const instruction = req.body?.prompt?.trim()
    if (!instruction || instruction.length < 3 || instruction.length > 2000)
      return res.status(400).json({ error: 'Describe your change in 3–2000 characters.' })

    const p = await queryOne(
      'SELECT id, status, generated_html FROM projects WHERE id=? AND user_id=? AND deleted_at IS NULL',
      [req.params.id, req.user.id]
    )
    if (!p) return res.status(404).json({ error: 'Project not found.' })
    if (p.status !== 'ready' || !p.generated_html)
      return res.status(409).json({ error: 'Project is not ready to edit.' })

    // Credits check (sends the 402 response itself when short)
    if (!(await hasEditCredits(req.user.id, res))) return

    // Merge the user's answers into the instruction
    const answers = Array.isArray(req.body?.answers) ? req.body.answers.slice(0, 3) : []
    const details = answers
      .map(a => ({
        q: String(a?.question || '').slice(0, 200),
        a: String(a?.answer || '').slice(0, 300),
      }))
      .filter(x => x.q && x.a)
      .map(x => `- ${x.q} ${x.a}`)
      .join('\n')
    const finalInstruction = details
      ? `${instruction}\n\nUser's clarifications:\n${details}`
      : instruction

    // Atomic lock: stops two parallel edits from spending the same credits
    const lock = await query(
      `UPDATE projects SET status='editing', current_step=?, edit_error=NULL WHERE id=? AND status='ready'`,
      ['Applying your changes...', p.id]
    )
    if (lock && lock.affectedRows === 0)
      return res.status(409).json({ error: 'An edit is already in progress.' })

    res.json({ message: 'Edit started!', projectId: p.id, status: 'editing' })

    editWebsite(p.id, req.user.id, p.generated_html, finalInstruction)
  } catch (err) {
    console.error('editProject:', err)
    res.status(500).json({ error: 'Failed to start edit.' })
  }
}

// ── GET /api/projects/:id/versions ────────────────────────────
export const getVersions = async (req, res) => {
  try {
    const p = await queryOne('SELECT id FROM projects WHERE id=? AND user_id=?', [req.params.id, req.user.id])
    if (!p) return res.status(404).json({ error: 'Not found.' })
    const versions = await query(
  `SELECT version_no, prompt, credits_used, created_at, github_url, deployed_at
   FROM project_versions WHERE project_id=? ORDER BY version_no DESC`, [p.id])
    res.json({ versions })
  } catch { res.status(500).json({ error: 'Failed to fetch versions.' }) }
}

// ── POST /api/projects/:id/restore/:versionNo (free) ──────────
export const restoreVersion = async (req, res) => {
  try {
    const p = await queryOne(
      `SELECT id FROM projects WHERE id=? AND user_id=? AND status='ready'`, [req.params.id, req.user.id])
    if (!p) return res.status(404).json({ error: 'Project not found or busy.' })
    const v = await queryOne(
      'SELECT html FROM project_versions WHERE project_id=? AND version_no=?', [p.id, req.params.versionNo])
    if (!v) return res.status(404).json({ error: 'Version not found.' })
    await query('UPDATE projects SET generated_html=?, updated_at=NOW() WHERE id=?', [v.html, p.id])
    res.json({ message: 'Version restored.' })
  } catch { res.status(500).json({ error: 'Restore failed.' }) }
}
const generateWithAI = async (prompt) => {
  let html = ''
  const stream = anthropic.messages.stream({
    model: 'claude-opus-4-8',
    max_tokens: 52000,
    system: AI_PROMPT,
    messages: [{ role: 'user', content: `Create a complete professional website for: ${prompt}` }],
  })
  for await (const chunk of stream) {
    if (chunk.type === 'content_block_delta' && chunk.delta?.type === 'text_delta') {
      html += chunk.delta.text
    }
  }
  const result = await stream.finalMessage()
  if (result.stop_reason === 'max_tokens') {
    console.warn('Website generation hit max_tokens — output may be truncated')
  }
  return html
}
const generateEditQuestions = async (topic, instruction) => {
  const result = await anthropic.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 600,
    system: `You help clarify a change request for an existing website. Return ONLY a raw JSON array (no markdown, no explanation) of 1-3 short clarifying questions.

Each item must have EXACTLY this shape:
{"id": "q1", "question": "...", "options": ["...", "...", "..."]}

Rules:
- Questions must be specific to the website's topic AND the requested change.
- Each question needs 2-4 short, mutually exclusive options.
- Only ask what would meaningfully change the result (content, sections, layout, tone).
- If the request is already specific and unambiguous (e.g. "change the hero color to dark blue"), return [].`,
    messages: [{
      role: 'user',
      content: `Website topic: ${topic}\nRequested change: ${instruction}`,
    }],
  })
  const text = result.content.find(b => b.type === 'text')?.text || '[]'
  const clean = text.replace(/^```json\n?|```$/g, '').trim()
  try {
    const parsed = JSON.parse(clean)
    return Array.isArray(parsed) ? parsed.slice(0, 3) : []
  } catch {
    return []
  }
}

const hasEditCredits = async (userId, res) => {
  const user = await queryOne('SELECT credits FROM users WHERE id=?', [userId])
  if (user && user.credits >= WEBSITE_EDIT_CREDITS) return true
  res.status(402).json({
    error: `An edit needs ${WEBSITE_EDIT_CREDITS} credits.`,
    code: 'INSUFFICIENT_CREDITS',
    required: WEBSITE_EDIT_CREDITS,
    balance: user?.credits ?? 0,
    purchase: { plan: 'pack100', price: 99, credits: 100 },
  })
  return false
}
// Always asked after the AI's topic questions
const FIXED_QUESTIONS = [
  {
    id: 'bg_color',
    question: 'Which background color style do you want for your website?',
    options: ['White & clean', 'Dark / black', 'Warm cream / beige', 'Soft pastel', 'Bold gradient'],
    allowCustom: true,
  },
  {
    id: 'extra',
    question: 'Anything else you want to add? (optional)',
    type: 'text',
    optional: true,
    placeholder: 'e.g. add an offers section, use a specific tagline, show opening hours...',
  },
]
const generateQuestions = async (prompt) => {
  const result = await anthropic.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 500,
    system: `You help clarify website requirements. Based on the user's topic, return ONLY a raw JSON array (no markdown, no explanation) of 2-4 short clarifying questions that would help generate a better website.

Each item must have EXACTLY this shape:
{"id": "q1", "question": "...", "options": ["...", "...", "..."]}

Rules:
- Each question needs 2-4 short, mutually exclusive answer options.
- Questions must be specific to the topic (e.g. for a restaurant: menu type, ordering method, special sections).
- Only ask what would meaningfully change the website's content, sections, or structure.
- Do NOT ask about background color, colors, fonts, or "anything else" — those are asked separately.
- If the topic is already very specific, return [].`,
    messages: [{ role: 'user', content: `Topic: ${prompt}` }],
  })
  const text = result.content.find(b => b.type === 'text')?.text || '[]'
  const clean = text.replace(/^```json\n?|```$/g, '').trim()
  let topicQs = []
  try {
    const parsed = JSON.parse(clean)
    if (Array.isArray(parsed)) {
      topicQs = parsed.slice(0, 4).map((q, i) => ({ ...q, id: `q${i + 1}`, allowCustom: true }))
    }
  } catch {}
  return [...topicQs, ...FIXED_QUESTIONS]   // fixed questions are always included
}
// ── POST /api/projects ────────────────────────────────────────
export const createProject = async (req, res) => {
  let id
  try {
    const { prompt, title } = req.body
    if (!prompt?.trim() || prompt.trim().length < 10)
      return res.status(400).json({ error: 'Please describe your website in at least 10 characters.' })

    id = uuidv4()
    const ptitle = title?.trim() || prompt.trim().slice(0, 80)

    await query(
      `INSERT INTO projects (id, user_id, title, prompt, status, download_paid, current_step)
       VALUES (?, ?, ?, ?, 'analyzing', 0, 'Analyzing your prompt...')`,
      [id, req.user.id, ptitle, prompt.trim()]
    )

    console.log(`🚀 Project ${id} by user ${req.user.id}`)
    res.status(201).json({ projectId: id, status: 'analyzing', message: 'Preparing questions...' })
  } catch (err) {
    console.error('createProject:', err)
    return res.status(500).json({ error: 'Failed to create project.' })
  }

  // Generate questions in background, then wait for answers
  generateQuestions(req.body.prompt.trim())
    .then(async (questions) => {
      if (!questions.length) {
        // fallback: no questions generated, go straight to generation
        await query(`UPDATE projects SET status='generating', current_step=? WHERE id=?`,
          ['Designing layout & writing content...', id])
        return generateWebsite(id, req.body.prompt.trim(), req.user.id, WEBSITE_GEN_CREDITS)
      }
      await query(`UPDATE projects SET status='awaiting_answers', questions=?, current_step=NULL WHERE id=?`,
        [JSON.stringify(questions), id])
    })
      .catch(async (err) => {
  console.error(`Question gen failed ${id}:`, err.message)
  await query(
    `UPDATE projects SET status='failed', current_step=NULL, edit_error=?, error_detail=?, updated_at=NOW() WHERE id=?`,
    ['AI service is temporarily unavailable. You were not charged. Please try again later.', errText(err), id]
  ).catch(() => {})
})
}

// ── GET /api/projects/:id/questions ────────────────────────────
export const getProjectQuestions = async (req, res) => {
  try {
    const p = await queryOne(
      'SELECT id, status, questions FROM projects WHERE id=? AND user_id=?',
      [req.params.id, req.user.id]
    )
    if (!p) return res.status(404).json({ error: 'Not found.' })
    res.json({
      status: p.status,
      questions: p.questions ? JSON.parse(p.questions) : [],
    })
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch questions.' })
  }
}
// ── GET /api/projects/:id/questions ────────────────────────────

// ── POST /api/projects/:id/answers ─────────────────────────────
export const submitProjectAnswers = async (req, res) => {
  try {
    const { answers } = req.body // { q1: "...", bg_color: "...", extra: "..." }
    const p = await queryOne(
      'SELECT * FROM projects WHERE id=? AND user_id=? AND deleted_at IS NULL',
      [req.params.id, req.user.id]
    )
    if (!p) return res.status(404).json({ error: 'Project not found.' })

    // Only accept answers while the project is waiting for them
    if (p.status !== 'awaiting_answers')
      return res.status(409).json({ error: 'This project is not waiting for answers.' })

    const questions = p.questions ? JSON.parse(p.questions) : []

    // Clean answers: strings only, trimmed, length-limited
    const clean = {}
    for (const q of questions) {
      const a = String(answers?.[q.id] ?? '').trim().slice(0, 500)
      if (a) clean[q.id] = a
    }

    // Required questions must be answered (optional ones can be skipped)
    const missing = questions.find(q => !q.optional && !clean[q.id])
    if (missing)
      return res.status(400).json({ error: `Please answer: ${missing.question}` })

    const answerText = questions
      .map(q => {
        const a = clean[q.id]
        if (!a) return null   // skipped optional question
        if (q.id === 'bg_color') return `BACKGROUND COLOR / THEME (must follow exactly): ${a}`
        if (q.id === 'extra')    return `ADDITIONAL REQUIREMENTS from the user (must include): ${a}`
        return `${q.question} Answer: ${a}`
      })
      .filter(Boolean)
      .join('\n')

    const enhancedPrompt = answerText
      ? `${p.prompt}\n\nAdditional details:\n${answerText}`
      : p.prompt

    // Atomic lock: prevents a double submit from starting two generations
    const lock = await query(
      `UPDATE projects SET answers=?, status='generating', current_step=? WHERE id=? AND status='awaiting_answers'`,
      [JSON.stringify(clean), 'Designing layout & writing content...', p.id]
    )
    if (lock && lock.affectedRows === 0)
      return res.status(409).json({ error: 'Generation already started.' })

    res.json({ message: 'Generation started!', projectId: p.id })

    generateWebsite(p.id, enhancedPrompt, req.user.id, WEBSITE_GEN_CREDITS).catch(err =>
      console.error(`Generation failed ${p.id}:`, err.message)
    )
  } catch (err) {
    console.error('submitProjectAnswers:', err.message)
    res.status(500).json({ error: 'Failed to submit answers.' })
  }
}
// ── Background generation ─────────────────────────────────────
const generateWebsite = async (projectId, prompt, userId, creditAmount) => {
  try {
    console.log(`⚡ Generating: ${projectId}`)

    await query(`UPDATE projects SET current_step=? WHERE id=?`,
      ['Designing layout & writing content...', projectId])

    const rawHtml = await generateWithAI(prompt)

    await query(`UPDATE projects SET current_step=? WHERE id=?`,
      ['Adding styles, animations & responsiveness...', projectId])

    const html = rawHtml
      .replace(/^```html?\n?/i, '')
      .replace(/\n?```$/i, '')
      .trim()

    if (!html || html.length < 100) throw new Error('HTML too short or empty')
const trackedHtml = injectTrackingScript(html, projectId)

await query(`UPDATE projects SET current_step=? WHERE id=?`,
  ['Finalizing your website...', projectId])

await query(
  `UPDATE projects SET generated_html=?, status='ready', current_step=NULL, updated_at=NOW() WHERE id=?`,
  [trackedHtml, projectId]
)


        await deductAfterSuccess(userId, creditAmount)
    console.log(`✅ Ready: ${projectId} (${html.length} chars)`)

    // ── Post-generation emails ──
    const [project, user] = await Promise.all([
      queryOne('SELECT title FROM projects WHERE id=?', [projectId]),
      queryOne('SELECT name, email, credits, has_paid FROM users WHERE id=?', [userId]),
    ])

    if (user) {
      if (!user.has_paid && project) {
        sendUnpaidProjectEmail({
          to: user.email,
          name: user.name,
          projectName: project.title,
          generatedAt: new Date(),
        })
      }
      if (user.credits <= 0) {
        sendZeroCreditsEmail({ to: user.email, name: user.name })
      }
    }
  
  }   catch (err) {
  await query(
    `UPDATE projects SET status='failed', current_step=NULL, edit_error=?, error_detail=?, updated_at=NOW() WHERE id=?`,
    ['Website generation failed. You were not charged. Please try again.', errText(err), projectId]
  )
  console.error(`❌ Generation failed ${projectId}:`, err.stack)
  throw err
}
}

// ── GET /api/projects ─────────────────────────────────────────
export const getUserProjects = async (req, res) => {
  try {
const websites = await query(
  `SELECT p.id, p.title, p.prompt, p.status, p.download_paid, p.created_at,
          p.github_url, p.github_repo, 'website' AS type,
          (SELECT MAX(version_no) FROM project_versions v WHERE v.project_id = p.id) AS latest_version,
          (SELECT v.prompt FROM project_versions v
             WHERE v.project_id = p.id ORDER BY v.version_no DESC LIMIT 1) AS latest_prompt
   FROM projects p
   WHERE p.user_id=? AND p.deleted_at IS NULL
   ORDER BY p.created_at DESC`,
  [req.user.id]
)

    const apps = await query(
      `SELECT id, title, prompt, status, download_paid, created_at,
              NULL AS github_url, NULL AS github_repo, 'app' AS type
       FROM apps WHERE user_id=? ORDER BY created_at DESC`,
      [req.user.id]
    )

    const projects = [...websites, ...apps].sort(
      (a, b) => new Date(b.created_at) - new Date(a.created_at)
    )

    res.json({ projects })
  } catch (err) {
    console.error('getUserProjects:', err)
    res.status(500).json({ error: 'Failed to fetch projects.' })
  }
}

// ── GET /api/projects/:id ─────────────────────────────────────
export const getProject = async (req, res) => {
  try {
    const p = await queryOne(
      'SELECT * FROM projects WHERE id=? AND user_id=?',
      [req.params.id, req.user.id]
    )
    if (!p) return res.status(404).json({ error: 'Project not found.' })

    // Show the saved error in the VS Code terminal when a failed project is opened
    if (p.status === 'failed') {
      console.log('\n==================== PROJECT ERROR ====================')
      console.log('Project ID :', p.id)
      console.log('Title      :', p.title)
      console.log('Message    :', p.edit_error || '(none)')
      console.log('Real error :', p.error_detail || '(not saved - project failed before this code was added)')
      console.log('=======================================================\n')
    }

    res.json({
      project: {
        id: p.id,
        title: p.title,
        prompt: p.prompt,
        status: p.status,
        download_paid: p.download_paid,
        generated_html: p.generated_html,
        created_at: p.created_at,
        github_url: p.github_url,
        github_repo: p.github_repo,
        type: 'website',
      },
    })
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch project.' })
  }
}

// ── GET /api/projects/:id/status ─────────────────────────────
export const getProjectStatus = async (req, res) => {
  try {
    const p = await queryOne(
      'SELECT id, status, download_paid, current_step, edit_error FROM projects WHERE id=? AND user_id=?',
      [req.params.id, req.user.id]
    )
    if (!p) return res.status(404).json({ error: 'Not found.' })
    res.json(p)
  } catch (err) {
    res.status(500).json({ error: 'Status check failed.' })
  }
}

export const downloadProject = async (req, res) => {
  try {
    

    const p = await queryOne(
      `SELECT * FROM projects WHERE id=? AND user_id=? AND status='ready'`,
      [req.params.id, req.user.id]
    )
    if (!p) return res.status(404).json({ error: 'Project not found or not ready.' })

    // ...rest unchanged (filename, headers, res.send)

    const filename =
      p.title
        .replace(/[^a-z0-9\s]/gi, '')
        .replace(/\s+/g, '_')
        .toLowerCase()
        .slice(0, 50) || 'website'

    res.setHeader('Content-Type', 'text/html; charset=utf-8')
    res.setHeader('Content-Disposition', `attachment; filename="${filename}.html"`)
    res.send(p.generated_html)
    console.log(`📦 Downloaded: ${p.id}`)
  } catch (err) {
    res.status(500).json({ error: 'Download failed.' })
  }
}

// ── DELETE /api/projects/:id ──────────────────────────────────
// ── DELETE /api/projects/:id ──────────────────────────────────
// ── DELETE /api/projects/:id ──────────────────────────────────
export const deleteProject = async (req, res) => {
  try {
    const p = await queryOne(
      'SELECT id FROM projects WHERE id=? AND user_id=?',
      [req.params.id, req.user.id]
    )
    if (!p) return res.status(404).json({ error: 'Not found.' })

    // Soft delete — keep the row, just mark it deleted
    await query('UPDATE projects SET deleted_at=NOW() WHERE id=?', [p.id])

    console.log(`🗑️ Project ${p.id} soft-deleted by user ${req.user.id}`)
    res.json({ message: 'Project deleted.' })
  } catch (err) {
    console.error('deleteProject:', err.sqlMessage || err.message)
    res.status(500).json({ error: 'Delete failed.' })
  }
}

// ── PUT /api/projects/:id ─────────────────────────────────────
export const updateProjectTitle = async (req, res) => {
  try {
    const { title } = req.body
    if (!title?.trim()) return res.status(400).json({ error: 'Title is required.' })

    const p = await queryOne(
      'SELECT id FROM projects WHERE id=? AND user_id=?',
      [req.params.id, req.user.id]
    )
    if (!p) return res.status(404).json({ error: 'Project not found.' })

    await query('UPDATE projects SET title=?, updated_at=NOW() WHERE id=?', [title.trim(), req.params.id])
    res.json({ message: 'Title updated.' })
  } catch (err) {
    res.status(500).json({ error: 'Failed to update title.' })
  }
}

// ── POST /api/projects/template ──────────────────────────────
export const saveTemplate = async (req, res) => {
  try {
    const { title, html, templateId } = req.body
    if (!title || !html) return res.status(400).json({ error: 'Title and HTML required.' })

    const id = uuidv4()
    await query(
      `INSERT INTO projects (id, user_id, title, prompt, generated_html, status)
 VALUES (?,?,?,?,?,?)`,
[id, req.user.id, title, `Pre-built template: ${templateId}`, html, 'ready']
    )
    res.json({ projectId: id, message: 'Template saved.' })
  } catch (err) {
    console.error('saveTemplate:', err)
    res.status(500).json({ error: 'Failed to save template.' })
  }
}
console.log('ANTHROPIC KEY:', process.env.ANTHROPIC_API_KEY ? 'loaded' : 'MISSING')
// ── POST /api/projects/:id/regenerate ────────────────────────
export const regenerateProject = async (req, res) => {
  try {
    const { prompt } = req.body
    const p = await queryOne(
      'SELECT * FROM projects WHERE id=? AND user_id=?',
      [req.params.id, req.user.id]
    )
    if (!p) return res.status(404).json({ error: 'Project not found.' })

    const newPrompt = prompt?.trim() || p.prompt

   await query(
  `UPDATE projects SET prompt=?, status='generating', generated_html=NULL, download_paid=0, current_step='Analyzing your prompt...', updated_at=NOW() WHERE id=?`,
  [newPrompt, req.params.id]
)

    res.json({ message: 'Regeneration started!', projectId: req.params.id })

    // Deducts credits only after success
    generateWebsite(req.params.id, newPrompt, req.user.id, WEBSITE_GEN_CREDITS).catch(err =>
      console.error(`Regen failed ${req.params.id}:`, err.message)
    )
  } catch (err) {
    res.status(500).json({ error: 'Failed to regenerate.' })
  }
}