// ============================================================
//  github-deploy-backend.js
//  Express router — mount at /api/github
//  Requires: express, axios, mysql2/promise (or your existing db)
// ============================================================

const express = require('express')
const router  = express.Router()
const axios   = require('axios')

const requireAuth  = require('./middleware/auth')
const requireAdmin = require('./middleware/admin')
const db = require('./db')   // mysql2 promise pool

// ── Shared GitHub axios factory ──────────────────────────────
function ghClient(token) {
  return axios.create({
    baseURL: 'https://api.github.com',
    headers: {
      Authorization: `token ${token}`,
      Accept:        'application/vnd.github.v3+json',
      'X-GitHub-Api-Version': '2022-11-28',
    },
  })
}

// ── Helper: wait N ms ────────────────────────────────────────
const wait = ms => new Promise(resolve => setTimeout(resolve, ms))

// ── Helper: retry a fn up to N times with delay ─────────────
async function retry(fn, times = 5, delayMs = 2000) {
  let lastErr
  for (let i = 0; i < times; i++) {
    try { return await fn() } catch (e) { lastErr = e; await wait(delayMs) }
  }
  throw lastErr
}

// ============================================================
//  ADMIN ROUTES
// ============================================================

// GET /api/github/admin/token
router.get('/admin/token', requireAuth, requireAdmin, async (req, res) => {
  try {
    const [rows] = await db.query(
      'SELECT id, github_username, created_at, updated_at FROM github_config LIMIT 1'
    )
    if (rows.length === 0) return res.json({ configured: false })
    return res.json({ configured: true, username: rows[0].github_username, updated_at: rows[0].updated_at })
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: 'DB error' })
  }
})

// POST /api/github/admin/token
router.post('/admin/token', requireAuth, requireAdmin, async (req, res) => {
  const { token, username } = req.body
  if (!token || !username) return res.status(400).json({ error: 'token and username are required' })

  try {
    const verify = await axios.get('https://api.github.com/user', {
      headers: { Authorization: `token ${token}`, Accept: 'application/vnd.github.v3+json' },
    })
    if (verify.data.login.toLowerCase() !== username.toLowerCase()) {
      return res.status(400).json({ error: 'Token does not match the provided username' })
    }
  } catch {
    return res.status(400).json({ error: 'Invalid GitHub token — verification failed' })
  }

  try {
    const [existing] = await db.query('SELECT id FROM github_config LIMIT 1')
    if (existing.length > 0) {
      await db.query(
        'UPDATE github_config SET github_token = ?, github_username = ?, updated_at = NOW() WHERE id = ?',
        [token, username, existing[0].id]
      )
    } else {
      await db.query('INSERT INTO github_config (github_token, github_username) VALUES (?, ?)', [token, username])
    }
    res.json({ success: true, message: 'GitHub token saved successfully' })
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: 'Failed to save token' })
  }
})

// DELETE /api/github/admin/token
router.delete('/admin/token', requireAuth, requireAdmin, async (req, res) => {
  try {
    await db.query('DELETE FROM github_config')
    res.json({ success: true, message: 'GitHub token removed' })
  } catch (err) {
    res.status(500).json({ error: 'Failed to remove token' })
  }
})

// GET /api/github/admin/deployments
router.get('/admin/deployments', requireAuth, requireAdmin, async (req, res) => {
  try {
    const [rows] = await db.query(`
      SELECT d.*, u.name AS user_name, u.email AS user_email
      FROM github_deployments d
      LEFT JOIN users u ON d.user_id = u.id
      ORDER BY d.created_at DESC LIMIT 200
    `)
    res.json({ deployments: rows })
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: 'DB error' })
  }
})

// ============================================================
//  USER ROUTES
// ============================================================

// GET /api/github/status
router.get('/status', async (req, res) => {
  try {
    const [rows] = await db.query('SELECT id FROM github_config LIMIT 1')
    res.json({ available: rows.length > 0 })
  } catch {
    res.json({ available: false })
  }
})

// ============================================================
//  GET /api/github/check-live
//
//  Called by the frontend to poll whether a GitHub Pages URL
//  is actually responding with a 200 yet.
//  The backend makes the HEAD request to avoid CORS issues
//  that would block the browser from fetching github.io directly.
//
//  Query params:
//    url  — the full live URL to check, e.g.
//           https://zaterbusiness.github.io/grand-hotel
// ============================================================
router.get('/check-live', requireAuth, async (req, res) => {
  const { url } = req.query
  if (!url) return res.status(400).json({ error: 'url query param is required' })

  // Only allow github.io URLs for security
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
      validateStatus: null, // don't throw on any HTTP status
    })
    const live = response.status === 200
    res.json({ live, status: response.status })
  } catch (err) {
    // Network error / timeout means not live yet
    res.json({ live: false, status: null, error: err.message })
  }
})

// ============================================================
//  POST /api/github/deploy
// ============================================================
router.post('/deploy', requireAuth, async (req, res) => {
  const { templateId, templateName, html } = req.body
  const userId = req.user.id

  if (!templateId || !templateName || !html) {
    return res.status(400).json({ error: 'templateId, templateName, and html are required' })
  }

  // 1 ── Load admin credentials
  let adminToken, adminUsername
  try {
    const [rows] = await db.query('SELECT github_token, github_username FROM github_config LIMIT 1')
    if (rows.length === 0) {
      return res.status(503).json({ error: 'Deployment service is not configured. Contact admin.' })
    }
    adminToken    = rows[0].github_token
    adminUsername = rows[0].github_username
  } catch {
    return res.status(500).json({ error: 'Failed to load deployment config' })
  }

  const gh = ghClient(adminToken)

  // 2 ── Build clean slug: "Grand Hotel" → "grand-hotel"
  //      URL will be: zaterbusiness.github.io/grand-hotel
  const baseSlug = templateName
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 50)

  // 3 ── Find an available repo name (grand-hotel, grand-hotel-2, …)
  let repoName = baseSlug
  for (let attempt = 2; attempt <= 20; attempt++) {
    try {
      await gh.get(`/repos/${adminUsername}/${repoName}`)
      // 200 = repo exists → try next suffix
      repoName = `${baseSlug}-${attempt}`
    } catch (e) {
      if (e.response?.status === 404) break  // name is free ✓
      return res.status(500).json({ error: `GitHub error checking repo name: ${e.message}` })
    }
  }

  try {
    // 4 ── Create repo with auto_init:true (creates "main" branch + README immediately)
    await gh.post('/user/repos', {
      name:         repoName,
      description:  `${templateName} — deployed via Zater Web Studio`,
      private:      false,
      auto_init:    true,    // ← CRITICAL: ensures main branch exists before we push
      has_issues:   false,
      has_wiki:     false,
      has_projects: false,
    })

    // 5 ── Wait for GitHub to finish internal repo initialisation
    await wait(1500)

    // 6 ── Fetch README.md SHA so we can delete it cleanly
    let readmeSha
    try {
      const r = await retry(
        () => gh.get(`/repos/${adminUsername}/${repoName}/contents/README.md`),
        4, 1500
      )
      readmeSha = r.data.sha
    } catch {
      readmeSha = null
    }

    // 7 ── Delete the auto-generated README
    if (readmeSha) {
      await gh.delete(`/repos/${adminUsername}/${repoName}/contents/README.md`, {
        data: { message: 'Remove auto-generated README', sha: readmeSha },
      })
    }

    // 8 ── Push index.html onto main branch
    const htmlBase64 = Buffer.from(html, 'utf8').toString('base64')
    await gh.put(`/repos/${adminUsername}/${repoName}/contents/index.html`, {
      message: `Deploy ${templateName}`,
      content: htmlBase64,
    })

    // 9 ── Enable GitHub Pages (source = main branch, root path)
    await retry(async () => {
      await gh.post(`/repos/${adminUsername}/${repoName}/pages`, {
        source: { branch: 'main', path: '/' },
      })
    }, 5, 2000)

    // 10 ── Assemble URLs
    const liveUrl = `https://${adminUsername}.github.io/${repoName}`
    const repoUrl = `https://github.com/${adminUsername}/${repoName}`

    // 11 ── Persist to DB — status starts as 'deploying'
    //       The webhook (or frontend polling confirmation) will flip it to 'live'
    await db.query(
      `INSERT INTO github_deployments
         (user_id, template_id, template_name, repo_name, repo_url, live_url, status)
       VALUES (?, ?, ?, ?, ?, ?, 'deploying')`,
      [userId, templateId, templateName, repoName, repoUrl, liveUrl]
    )

    // 12 ── Return immediately — frontend will poll /check-live
    return res.json({
      success:  true,
      liveUrl,
      repoUrl,
      repoName,
    })

  } catch (err) {
    const apiMsg = err.response?.data?.message
    const msg    = apiMsg || err.message
    console.error('GitHub deploy error:', msg, err.response?.data)

    // Best-effort rollback: delete partially-created repo
    try { await gh.delete(`/repos/${adminUsername}/${repoName}`) } catch {}

    return res.status(500).json({ error: `Deploy failed: ${msg}` })
  }
})

// GET /api/github/deployments — current user's history
router.get('/deployments', requireAuth, async (req, res) => {
  try {
    const [rows] = await db.query(
      `SELECT id, template_id, template_name, repo_name, repo_url, live_url, status, created_at
       FROM github_deployments
       WHERE user_id = ?
       ORDER BY created_at DESC`,
      [req.user.id]
    )
    res.json({ deployments: rows })
  } catch (err) {
    res.status(500).json({ error: 'DB error' })
  }
})

// PATCH /api/github/deployments/:id/status — admin override
router.patch('/deployments/:id/status', requireAuth, requireAdmin, async (req, res) => {
  const { status } = req.body
  try {
    await db.query('UPDATE github_deployments SET status = ? WHERE id = ?', [status, req.params.id])
    res.json({ success: true })
  } catch (err) {
    res.status(500).json({ error: 'DB error' })
  }
})

// ── GitHub Pages webhook → auto-mark status 'live' ──────────
// Configure in each deployed repo → Settings → Webhooks:
//   Payload URL : https://yourdomain.com/api/github/webhook
//   Content type: application/json
//   Events      : GitHub Pages deployments (page_build)
router.post('/webhook', express.json(), async (req, res) => {
  const event    = req.headers['x-github-event']
  const repoName = req.body?.repository?.name
  if (event === 'page_build' && req.body?.build?.status === 'built' && repoName) {
    try {
      await db.query(
        "UPDATE github_deployments SET status = 'live' WHERE repo_name = ?",
        [repoName]
      )
    } catch (e) { console.error('Webhook DB error:', e.message) }
  }
  res.sendStatus(200)
})

module.exports = router


// ============================================================
//  SQL SCHEMA — run once
// ============================================================
/*
CREATE TABLE IF NOT EXISTS github_config (
  id              INT AUTO_INCREMENT PRIMARY KEY,
  github_token    VARCHAR(255) NOT NULL,
  github_username VARCHAR(100) NOT NULL,
  created_at      TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at      TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS github_deployments (
  id            INT AUTO_INCREMENT PRIMARY KEY,
  user_id       INT NOT NULL,
  template_id   VARCHAR(50),
  template_name VARCHAR(255),
  repo_name     VARCHAR(255),
  repo_url      VARCHAR(500),
  live_url      VARCHAR(500),
  status        ENUM('deploying','live','failed') DEFAULT 'deploying',
  created_at    TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

-- Mount in server.js / app.js:
--   const githubRouter = require('./github-deploy-backend');
--   app.use('/api/github', githubRouter);
*/
