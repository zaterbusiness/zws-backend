// controllers/githubController.js
// controllers/githubController.js
import { Octokit } from '@octokit/rest'
import db          from '../config/db.js'
import { injectTrackingScript } from './analyticsController.js'   // ← add this import

const REPO_NAME = 'zater-sites'
const wait = ms => new Promise(r => setTimeout(r, ms))

// Retries a fn on transient network errors (connect timeouts, ECONNRESET, etc).
// Does NOT retry on real API errors (404, 401, 422, etc) — only network-level failures.
async function withRetry(fn, label, attempts = 3) {
  let lastErr
  for (let i = 1; i <= attempts; i++) {
    try {
      return await fn()
    } catch (err) {
      lastErr = err
      const isNetworkError =
        err.code === 'UND_ERR_CONNECT_TIMEOUT' ||
        err.code === 'ECONNRESET' ||
        err.code === 'ETIMEDOUT' ||
        (err.name === 'HttpError' && !err.status) || // octokit wraps network errors without a status
        /timeout|ECONNRESET|fetch failed/i.test(err.message || '')
      if (!isNetworkError || i === attempts) throw err
      console.warn(`[GitHub] ⚠️ ${label} failed (attempt ${i}/${attempts}): ${err.message} — retrying in ${i * 1500}ms`)
      await wait(i * 1500)
    }
  }
  throw lastErr
}

function toSlug(str = '') {
  return str.toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '').slice(0, 50) || 'site'
}

// ─────────────────────────────────────────────────────────────────────────────
// ADMIN TOKEN LOOKUP
// All deploys (by any user) use the admin's GitHub token.
// The admin must connect their GitHub account once from the Settings page.
// No hardcoded ID needed — we just query WHERE role = 'admin'.
// ─────────────────────────────────────────────────────────────────────────────
async function getUserOctokit() {
  const [rows] = await db.query(
    "SELECT github_token, github_username FROM users WHERE role = 'admin' AND github_token IS NOT NULL LIMIT 1"
  )
  if (!rows.length || !rows[0].github_token) {
    throw new Error(
      'GitHub hosting is not set up yet. Please ask the admin to connect a GitHub account in Settings → GitHub Hosting.'
    )
  }
  return {
    octokit:  new Octokit({ auth: rows[0].github_token, request: { timeout: 20000 } }),
    username: rows[0].github_username,
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// CORE: Push files to gh-pages using Git Tree API
// ─────────────────────────────────────────────────────────────────────────────
async function pushToGhPages(octokit, username, files, commitMsg) {
  // A. Ensure repo exists
  let defaultBranch = 'main'
  try {
    const { data } = await withRetry(
      () => octokit.repos.get({ owner: username, repo: REPO_NAME }),
      'repos.get'
    )
    defaultBranch = data.default_branch
    console.log(`[GitHub] ✅ Repo exists. Default branch: ${defaultBranch}`)
  } catch (err) {
    if (err.status !== 404) throw err
    console.log(`[GitHub] Creating repo...`)
    const { data } = await withRetry(
      () => octokit.repos.createForAuthenticatedUser({
        name: REPO_NAME, description: 'Sites built with Zater Web Studio',
        private: false, auto_init: true,
      }),
      'repos.createForAuthenticatedUser'
    )
    defaultBranch = data.default_branch || 'main'
    console.log(`[GitHub] ✅ Repo created. Waiting 5s...`)
    await wait(5000)
  }

  // B. Get or create gh-pages branch
  let parentSha
  try {
    const { data } = await withRetry(
      () => octokit.repos.getBranch({ owner: username, repo: REPO_NAME, branch: 'gh-pages' }),
      'getBranch:gh-pages'
    )
    parentSha = data.commit.sha
    console.log(`[GitHub] ✅ gh-pages exists. HEAD: ${parentSha}`)
  } catch (err) {
    if (err.status !== 404) throw err
    console.log(`[GitHub] Creating gh-pages from ${defaultBranch}...`)
    const { data } = await withRetry(
      () => octokit.repos.getBranch({ owner: username, repo: REPO_NAME, branch: defaultBranch }),
      'getBranch:default'
    )
    parentSha = data.commit.sha
    await withRetry(
      () => octokit.git.createRef({ owner: username, repo: REPO_NAME, ref: 'refs/heads/gh-pages', sha: parentSha }),
      'createRef'
    )
    console.log(`[GitHub] ✅ gh-pages created`)
  }

  // C. Create blobs for each file
  console.log(`[GitHub] Creating ${files.length} blob(s)...`)
  const treeItems = []
  for (const file of files) {
    const b64 = Buffer.from(file.content, 'utf-8').toString('base64')
    const { data: blob } = await withRetry(
      () => octokit.git.createBlob({
        owner: username, repo: REPO_NAME, content: b64, encoding: 'base64',
      }),
      `createBlob:${file.path}`
    )
    console.log(`[GitHub] ✅ Blob: ${file.path} → ${blob.sha}`)
    treeItems.push({ path: file.path, mode: '100644', type: 'blob', sha: blob.sha })
  }

  // D. Get parent tree SHA
  const { data: parentCommit } = await withRetry(
    () => octokit.git.getCommit({ owner: username, repo: REPO_NAME, commit_sha: parentSha }),
    'getCommit'
  )
  console.log(`[GitHub] Parent tree: ${parentCommit.tree.sha}`)

  // E. Create new tree
  const { data: newTree } = await withRetry(
    () => octokit.git.createTree({
      owner: username, repo: REPO_NAME,
      base_tree: parentCommit.tree.sha,
      tree: treeItems,
    }),
    'createTree'
  )
  console.log(`[GitHub] ✅ New tree: ${newTree.sha}`)

  // F. Create commit
  const { data: newCommit } = await withRetry(
    () => octokit.git.createCommit({
      owner: username, repo: REPO_NAME,
      message: commitMsg, tree: newTree.sha, parents: [parentSha],
    }),
    'createCommit'
  )
  console.log(`[GitHub] ✅ New commit: ${newCommit.sha}`)

  // G. Update gh-pages ref
  await withRetry(
    () => octokit.git.updateRef({
      owner: username, repo: REPO_NAME,
      ref: 'heads/gh-pages', sha: newCommit.sha, force: true,
    }),
    'updateRef'
  )
  console.log(`[GitHub] ✅ gh-pages updated`)
  return newCommit.sha
}

async function enablePages(octokit, username) {
  try {
    await withRetry(
      () => octokit.repos.createPagesSite({ owner: username, repo: REPO_NAME, source: { branch: 'gh-pages', path: '/' } }),
      'createPagesSite'
    )
    console.log(`[GitHub] ✅ Pages enabled`)
  } catch (err) {
    if (err.status === 409) console.log(`[GitHub] Pages already enabled`)
    else console.warn(`[GitHub] Pages warning: ${err.message}`)
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/hosting/github-status
// Returns admin's GitHub connection status.
// canManage = true only for admin users (shows Connect/Disconnect button).
// ─────────────────────────────────────────────────────────────────────────────
export async function getGithubStatus(req, res) {
  try {
    const [rows] = await db.query(
      "SELECT github_username FROM users WHERE role = 'admin' AND github_token IS NOT NULL LIMIT 1"
    )
    const username = rows[0]?.github_username || null
    const canManage = req.user.role === 'admin'          // only admin sees Connect/Disconnect
    return res.json({ connected: !!username, username, canManage })
  } catch (err) {
    return res.status(500).json({ error: 'Could not fetch GitHub status' })
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/hosting/github-connect
// ADMIN ONLY — saves a GitHub PAT for the admin account.
// Regular users will get 403.
// ─────────────────────────────────────────────────────────────────────────────
export async function connectGithub(req, res) {
  // ── ADMIN GUARD ──────────────────────────────────────────────────────────
  if (req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Only admins can connect a GitHub account.' })
  }

  const { token } = req.body
  if (!token?.trim()) return res.status(400).json({ error: 'Token is required.' })
  const t = token.trim()
  if (!t.startsWith('ghp_') && !t.startsWith('github_pat_')) {
    return res.status(400).json({ error: 'Token looks invalid. GitHub tokens start with ghp_ or github_pat_' })
  }

  try {
    const userOctokit = new Octokit({ auth: t })
    const { data } = await userOctokit.users.getAuthenticated()
    const scopeRes = await userOctokit.request('GET /user')
    const scopes = (scopeRes.headers['x-oauth-scopes'] || '').split(',').map(s => s.trim())
    if (!scopes.includes('repo') && !scopes.includes('public_repo')) {
      return res.status(400).json({ error: 'Token is missing the "repo" scope.' })
    }
    // Save token to the admin's own row (req.user.id is the admin's id here)
    await db.query(
      'UPDATE users SET github_token = ?, github_username = ? WHERE id = ?',
      [t, data.login, req.user.id]
    )
    return res.json({ connected: true, username: data.login })
  } catch (err) {
    if (err.status === 401) return res.status(400).json({ error: 'Invalid token.' })
    return res.status(400).json({ error: err.message || 'Could not connect GitHub.' })
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// DELETE /api/hosting/github-connect
// ADMIN ONLY — clears the admin's GitHub token.
// ─────────────────────────────────────────────────────────────────────────────
export async function disconnectGithub(req, res) {
  // ── ADMIN GUARD ──────────────────────────────────────────────────────────
  if (req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Only admins can disconnect GitHub.' })
  }

  try {
    await db.query(
      'UPDATE users SET github_token = NULL, github_username = NULL WHERE id = ?',
      [req.user.id]
    )
    return res.json({ disconnected: true })
  } catch (err) {
    return res.status(500).json({ error: 'Could not disconnect GitHub.' })
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/hosting/github-pages
// Any logged-in user can deploy. Uses the admin's GitHub token.
// Each user's sites are stored in:  user-{userId}/{templateSlug}/{projectId}/
// so no two users can ever overwrite each other.
// ─────────────────────────────────────────────────────────────────────────────
export async function deployToGithubPages(req, res) {
  const userId = req.user.id
  let { projectId, html, title, templateName, subdomain } = req.body

  console.log(`\n${'='.repeat(60)}`)
  console.log(`[GitHub] DEPLOY START user=${userId} projectId=${projectId}`)
  console.log(`[GitHub] body html=${html?.length ?? 'NOT SENT'} chars`)
  console.log(`${'='.repeat(60)}`)

  try {
    // 1. Get admin credentials (no user token needed)
// 1. Get admin credentials (no user token needed)
let octokit, username
try {
  ({ octokit, username } = await getUserOctokit())
} catch (err) {
  return res.status(400).json({ error: err.message })
}

// ── PAYWALL: global unlock required for hosting ──
const [userRows] = await db.query('SELECT has_paid FROM users WHERE id = ?', [userId])
if (!userRows[0]?.has_paid) {
  return res.status(403).json({ error: 'Please pay ₹99 once to unlock download & hosting for all your websites.' })
}

    // 2. Resolve HTML
   // 2. Resolve HTML
if (projectId) {
  const [rows] = await db.query(
    'SELECT id, title, generated_html, subdomain, template_name, download_paid FROM projects WHERE id = ? AND user_id = ?',
    [projectId, userId]
  )
  if (!rows.length) return res.status(404).json({ error: 'Project not found.' })
  const p = rows[0]

  // ── PAYWALL: hosting requires the ₹99 unlock, same as download ──
  if (!p.download_paid) {
    return res.status(403).json({ error: 'Please pay ₹99 to unlock download & hosting for this website.' })
  }

  console.log(`[GitHub] DB html length: ${p.generated_html?.length ?? 'NULL'}`)
 

      if (p.generated_html && p.generated_html.trim().length > 10) {
        html = p.generated_html
      } else if (html && html.trim().length > 10) {
        console.log(`[GitHub] ⚠️ DB empty — using body html and patching DB`)
        await db.query('UPDATE projects SET generated_html = ? WHERE id = ? AND user_id = ?', [html, projectId, userId])
      } else {
        return res.status(400).json({ error: 'No HTML found. Please try again.' })
      }
      title        = title        || p.title
      templateName = templateName || p.template_name || p.subdomain || 'site'
    } else {
      if (!html || html.trim().length < 10) return res.status(400).json({ error: 'No HTML to deploy.' })
    }

    console.log(`[GitHub] HTML to deploy: ${html.length} chars`)
console.log(`[GitHub] HTML to deploy: ${html.length} chars`)

    // Inject view-tracking beacon before pushing to GitHub
    if (projectId) {
      html = injectTrackingScript(html, projectId)
      console.log(`[GitHub] Tracking script injected for project ${projectId}`)
    }
    // 3. Build namespaced folder path
    //    Structure: user-{userId}/{templateSlug}/{projectId}/index.html
    //    This ensures every user's sites are completely isolated.
    const templateSlug = toSlug(templateName || title || subdomain || 'site')
    const siteId       = projectId ? toSlug(String(projectId)) : `live-${Date.now()}`
    const userSlug     = `user-${userId}`                          // ← namespaces by user
    const folderPath   = `${userSlug}/${templateSlug}/${siteId}`   // ← full path in gh-pages
    const filePath     = `${folderPath}/index.html`
    console.log(`[GitHub] Target: gh-pages/${filePath}`)

    // 4. Push files (.nojekyll + index.html)
    await pushToGhPages(octokit, username, [
      { path: '.nojekyll', content: '' },
      { path: filePath,    content: html },
    ], `Deploy: ${title || templateSlug} (user ${userId}) via Zater Web Studio`)

    // 5. Enable Pages
    await enablePages(octokit, username)

    // 6. Live URL
    const liveUrl = `https://${username}.github.io/${REPO_NAME}/${folderPath}/`
    console.log(`[GitHub] 🌐 ${liveUrl}`)

    // 7. Save to DB
    try {
      await db.query(
        `INSERT INTO deployments (user_id, project_id, subdomain, repo_name, live_url, platform, deployed_at)
         VALUES (?, ?, ?, ?, ?, 'github_pages', NOW())
         ON DUPLICATE KEY UPDATE live_url = VALUES(live_url), deployed_at = NOW()`,
        [userId, projectId || null, `${templateSlug}-${siteId}`.slice(0, 100), REPO_NAME, liveUrl]
      )
      console.log(`[GitHub] ✅ Deployment record saved`)
    } catch (dbErr) {
      console.warn(`[GitHub] ⚠️ DB deployment record failed (non-fatal): ${dbErr.message}`)
    }

    try {
      if (projectId) {
        await db.query(
          'UPDATE projects SET github_url = ?, github_repo = ? WHERE id = ? AND user_id = ?',
          [liveUrl, `${username}/${REPO_NAME}`, projectId, userId]
        )
        console.log(`[GitHub] ✅ Project stamped with github_url`)
      }
    } catch (dbErr) {
      console.warn(`[GitHub] ⚠️ Project stamp failed (non-fatal): ${dbErr.message}`)
    }

    console.log(`[GitHub] ✅ DEPLOY COMPLETE`)
    return res.json({
      success: true, url: liveUrl, liveUrl,
      repoName: REPO_NAME, folder: folderPath,
      message: 'Deployed! GitHub Pages goes live in 1–3 minutes.',
    })

  } catch (err) {
    const detail = err.response?.data?.message || err.message
    console.error(`[GitHub] ❌ DEPLOY FAILED: ${detail}`)
    console.error(err.response?.data || err.stack)
    return res.status(500).json({ error: 'Deployment failed', details: detail })
  }
}