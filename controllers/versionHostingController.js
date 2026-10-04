import { v4 as uuidv4 } from 'uuid'
import { query, queryOne } from '../config/db.js'

const GH = 'https://api.github.com'

const gh = async (token, path, opts = {}) => {
  const r = await fetch(`${GH}${path}`, {
    ...opts,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'Content-Type': 'application/json',
      'User-Agent': 'zater-web-studio',
    },
  })
  const data = await r.json().catch(() => ({}))
  if (!r.ok) {
    const e = new Error(data.message || `GitHub error ${r.status}`)
    e.status = r.status
    throw e
  }
  return data
}

// Create or update a file in the repo
const putFile = async (token, owner, repo, path, html, message) => {
  let sha
  try {
    const existing = await gh(token, `/repos/${owner}/${repo}/contents/${path}`)
    sha = existing.sha
  } catch (e) { if (e.status !== 404) throw e }

  await gh(token, `/repos/${owner}/${repo}/contents/${path}`, {
    method: 'PUT',
    body: JSON.stringify({
      message,
      content: Buffer.from(html, 'utf8').toString('base64'),
      ...(sha ? { sha } : {}),
    }),
  })
}

// Reuse the project's repo, or create one the first time
const ensureRepo = async (token, owner, project) => {
  if (project.github_repo) return project.github_repo

  const slug = (project.title || 'site').toLowerCase()
    .replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 30) || 'site'
  const repo = `zws-${slug}-${project.id.slice(0, 8)}`

  await gh(token, '/user/repos', {
    method: 'POST',
    body: JSON.stringify({
      name: repo,
      description: 'Built with Zater Web Studio',
      private: false,
      auto_init: true,
    }),
  })
  return repo
}

const enablePages = async (token, owner, repo) => {
  try {
    await gh(token, `/repos/${owner}/${repo}/pages`, {
      method: 'POST',
      body: JSON.stringify({ source: { branch: 'main', path: '/' } }),
    })
  } catch (e) {
    if (e.status !== 409 && e.status !== 422) throw e   // already enabled = fine
  }
}

// ── POST /api/hosting/github-pages  { projectId, versionNo? } ──
// No versionNo  = deploy the CURRENT website (a snapshot version is created if needed)
// With versionNo = deploy that specific old version on its own URL
export const deployVersionToGithub = async (req, res) => {
  try {
    const { projectId, versionNo } = req.body

    const project = await queryOne(
      `SELECT id, title, status, generated_html, github_repo, github_url
       FROM projects WHERE id=? AND user_id=? AND deleted_at IS NULL`,
      [projectId, req.user.id]
    )
    if (!project) return res.status(404).json({ error: 'Project not found.' })
    if (project.status !== 'ready') return res.status(409).json({ error: 'Project is busy.' })

    const user = await queryOne(
      'SELECT github_token, github_username FROM users WHERE id=?', [req.user.id])
    if (!user?.github_token || !user?.github_username)
      return res.status(400).json({ error: 'NO_GITHUB_TOKEN: add your GitHub token in Settings.' })

    const token = user.github_token
    const owner = user.github_username

    // ── Resolve which version we are deploying ──
    let ver
    let isCurrent = false

    if (versionNo) {
      ver = await queryOne(
        'SELECT version_no, html, github_url FROM project_versions WHERE project_id=? AND version_no=?',
        [project.id, versionNo])
      if (!ver) return res.status(404).json({ error: 'Version not found.' })

      const latest = await queryOne(
        'SELECT html FROM project_versions WHERE project_id=? ORDER BY version_no DESC LIMIT 1',
        [project.id])
      isCurrent = project.generated_html === ver.html
    } else {
      // Current website: reuse a matching version, otherwise snapshot it as a new one
      isCurrent = true
      ver = await queryOne(
        `SELECT version_no, html, github_url FROM project_versions
         WHERE project_id=? AND html=? ORDER BY version_no DESC LIMIT 1`,
        [project.id, project.generated_html])

      if (!ver) {
        const last = await queryOne(
          'SELECT COALESCE(MAX(version_no),0) AS v FROM project_versions WHERE project_id=?',
          [project.id])
        const no = last.v + 1
        await query(
          `INSERT INTO project_versions (id, project_id, version_no, html, prompt, credits_used)
           VALUES (?,?,?,?,?,0)`,
          [uuidv4(), project.id, no, project.generated_html, 'Deployed snapshot'])
        ver = { version_no: no, html: project.generated_html, github_url: null }
      }
    }

    // ── Deploy ──
    const repo = await ensureRepo(token, owner, project)
    const base = `https://${owner}.github.io/${repo}/`
    const versionUrl = `${base}v${ver.version_no}/`

    await putFile(token, owner, repo, `v${ver.version_no}/index.html`, ver.html,
      `Deploy v${ver.version_no}`)

    // Repo root always mirrors the current version
    if (isCurrent) {
  await query(
    'UPDATE projects SET github_repo=?, github_url=?, updated_at=NOW() WHERE id=?',
    [repo, base, project.id])
} else {
  await query(
    'UPDATE projects SET github_repo=?, updated_at=NOW() WHERE id=?',
    [repo, project.id])
}

    await enablePages(token, owner, repo)

    await query(
      'UPDATE project_versions SET github_url=?, deployed_at=NOW() WHERE project_id=? AND version_no=?',
      [versionUrl, project.id, ver.version_no])

    await query(
      'UPDATE projects SET github_repo=?, github_url=?, updated_at=NOW() WHERE id=?',
      [repo, base, project.id])

    res.json({
      url: isCurrent ? base : versionUrl,   // frontend toast + project.github_url
      rootUrl: base,
      versionUrl,
      versionNo: ver.version_no,
      isCurrent,
    })
  } catch (err) {
    console.error('deployVersionToGithub:', err.message)
    const msg = err.status === 401 ? 'GitHub token is invalid or expired. Update it in Settings.' : err.message
    res.status(500).json({ error: msg || 'Deploy failed.' })
  }
}