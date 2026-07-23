// routes/hostingRoutes.js
import { Router } from 'express'
import axios from 'axios'
import { v4 as uuidv4 } from 'uuid'
import {
  checkSubdomain, createHostingOrder, verifyHostingPayment,
  getHostedSite, getMySites
} from '../controllers/hostingController.js'
import {
  deployToGithubPages,
  connectGithub,
  getGithubStatus,
  disconnectGithub
} from '../controllers/githubController.js'
import { protect } from '../middleware/auth.js'
import db from '../config/db.js'

const router = Router()

// ── Public ────────────────────────────────────────────────────────────────────
router.get('/site/:subdomain', getHostedSite)

// ── GitHub Pages live-check (proxy to avoid CORS) ─────────────────────────────
// GET /api/hosting/check-live?url=https://username.github.io/repo/folder/
router.get('/check-live', protect, async (req, res) => {
  const { url } = req.query
  if (!url) return res.status(400).json({ error: 'url query param is required' })

  try {
    const parsed = new URL(url)
    if (!parsed.hostname.endsWith('.github.io')) {
      return res.status(400).json({ error: 'Only github.io URLs are allowed' })
    }
  } catch {
    return res.status(400).json({ error: 'Invalid URL' })
  }

  try {
    const response = await axios.head(url, {
      timeout: 8000,
      validateStatus: null,
    })
    return res.json({ live: response.status === 200, status: response.status })
  } catch (err) {
    return res.json({ live: false, status: null, error: err.message })
  }
})
router.get('/check-live', async (req, res) => {
  const { url } = req.query
  if (!url) return res.status(400).json({ live: false })
  try {
    const r = await fetch(url, { method: 'HEAD', redirect: 'follow' })
    return res.json({ live: r.ok })
  } catch {
    return res.json({ live: false })
  }
})
// ── Save template as a project ────────────────────────────────────────────────
// POST /api/hosting/save-template
// Body: { title, html, templateId, templateName }
// Returns: { projectId }
//
// IMPORTANT: projects.id is VARCHAR(36) — must generate UUID manually on INSERT.
// ─────────────────────────────────────────────────────────────────────────────
router.post('/save-template', protect, async (req, res) => {
  try {
    const userId = req.user.id
    const { title, html, templateId, templateName } = req.body

    if (!title?.trim()) {
      return res.status(400).json({ error: 'title is required.' })
    }
    if (!html || html.trim().length < 10) {
      return res.status(400).json({ error: 'html content is required and cannot be empty.' })
    }

    const tplName = templateId || templateName || title.trim()
    console.log(`[SaveTemplate] user=${userId} | template=${tplName} | html=${html.length} chars`)

    // ── Check if already saved — update instead of duplicate insert ──────────
    const [existing] = await db.query(
      `SELECT id FROM projects
       WHERE user_id = ? AND template_name = ? AND status = 'ready'
       ORDER BY created_at DESC LIMIT 1`,
      [userId, tplName]
    )

    if (existing.length > 0) {
      const existingId = existing[0].id
      await db.query(
        `UPDATE projects
         SET generated_html = ?, title = ?, updated_at = NOW()
         WHERE id = ? AND user_id = ?`,
        [html, title.trim(), existingId, userId]
      )
      console.log(`[SaveTemplate] ✅ Updated existing project ${existingId}`)
      return res.json({ projectId: existingId, updated: true })
    }

    // ── Generate UUID — projects.id is VARCHAR(36) not AUTO_INCREMENT ────────
    const projectId = uuidv4()

    await db.query(
      `INSERT INTO projects
         (id, user_id, title, prompt, template_name, generated_html,
          status, is_template, download_paid, created_at, updated_at)
       VALUES (?, ?, ?, '', ?, ?, 'ready', 1, 1, NOW(), NOW())`,
      [projectId, userId, title.trim(), tplName, html]
    )

    console.log(`[SaveTemplate] ✅ Inserted project ${projectId} | ${html.length} chars`)
    return res.json({ projectId, created: true })

  } catch (err) {
    console.error('[SaveTemplate] Error:', err)
    return res.status(500).json({ error: 'Failed to save template: ' + err.message })
  }
})

// ── Protected hosting routes ──────────────────────────────────────────────────
router.get('/check-subdomain',   protect, checkSubdomain)
router.post('/order',            protect, createHostingOrder)
router.post('/verify',           protect, verifyHostingPayment)
router.get('/my-sites',          protect, getMySites)

// ── GitHub deployment routes ──────────────────────────────────────────────────
router.post('/github-pages',     protect, deployToGithubPages)
router.post('/github-connect',   protect, connectGithub)
router.get('/github-status',     protect, getGithubStatus)
router.delete('/github-connect', protect, disconnectGithub)

export default router
