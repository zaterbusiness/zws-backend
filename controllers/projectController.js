
import Anthropic from '@anthropic-ai/sdk'
import { v4 as uuidv4 } from 'uuid'
import { query, queryOne } from '../config/db.js'
import { deductAfterSuccess } from '../middleware/creditsCheck.js'
import { injectTrackingScript } from './analyticsController.js'

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
- DO NOT use external image URLs — use CSS gradients and SVG only.`

// REPLACE the entire generateWithAI function with this:
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
       VALUES (?, ?, ?, ?, 'generating', 0, 'Analyzing your prompt...')`,
      [id, req.user.id, ptitle, prompt.trim()]
    )

    console.log(`🚀 Project ${id} by user ${req.user.id}`)
    res.status(201).json({ projectId: id, status: 'generating', message: 'Generation started!' })
  } catch (err) {
    console.error('createProject:', err)
    return res.status(500).json({ error: 'Failed to create project.' })
  }

  // Fired only after response is sent — errors here can never double-send
  generateWebsite(id, req.body.prompt.trim(), req.user.id, WEBSITE_GEN_CREDITS).catch(err =>
    console.error(`Generation failed ${id}:`, err.message)
  )
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

    await query(
      `UPDATE projects SET generated_html=?, status='ready', current_step=NULL, updated_at=NOW() WHERE id=?`,
      [trackedHtml, projectId]   // was: [html, projectId]
    )
    await query(`UPDATE projects SET current_step=? WHERE id=?`,
      ['Finalizing your website...', projectId])

    await query(
      `UPDATE projects SET generated_html=?, status='ready', current_step=NULL, updated_at=NOW() WHERE id=?`,
      [html, projectId]
    )

    await deductAfterSuccess(userId, creditAmount)
    console.log(`✅ Ready: ${projectId} (${html.length} chars)`)
  } catch (err) {
    await query(`UPDATE projects SET status='failed', current_step=NULL, updated_at=NOW() WHERE id=?`, [projectId])
    console.error(`❌ Generation failed ${projectId}:`, err.message)
    throw err
  }
}

// ── GET /api/projects ─────────────────────────────────────────
export const getUserProjects = async (req, res) => {
  try {
    const websites = await query(
      `SELECT id, title, prompt, status, download_paid, created_at,
              github_url, github_repo, 'website' AS type
       FROM projects WHERE user_id=? ORDER BY created_at DESC`,
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
      'SELECT id, status, download_paid, current_step FROM projects WHERE id=? AND user_id=?',
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
    const user = await queryOne('SELECT has_paid FROM users WHERE id=?', [req.user.id])
    if (!user?.has_paid) {
      return res.status(403).json({ error: 'Please pay ₹99 once to unlock downloads & hosting for all your websites.' })
    }

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
export const deleteProject = async (req, res) => {
  try {
    const p = await queryOne(
      'SELECT id FROM projects WHERE id=? AND user_id=?',
      [req.params.id, req.user.id]
    )
    if (!p) return res.status(404).json({ error: 'Not found.' })
    await query('DELETE FROM projects WHERE id=?', [p.id])
    res.json({ message: 'Project deleted.' })
  } catch (err) {
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