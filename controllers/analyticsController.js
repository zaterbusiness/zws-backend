import { query, queryOne } from '../config/db.js'
import crypto from 'crypto'

const API_BASE = process.env.PUBLIC_API_BASE_URL || 'https://YOUR-BACKEND.onrender.com'

// Injected into every generated_html before it's saved / pushed to GitHub
export const injectTrackingScript = (html, projectId) => {
  const script = `<script>(function(){try{fetch('${API_BASE}/api/analytics/track/${projectId}',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({referrer:document.referrer})}).catch(function(){});}catch(e){}})();</script>`
  return html.includes('</body>') ? html.replace('</body>', `${script}\n</body>`) : html + script
}

// POST /api/analytics/track/:projectId — PUBLIC, called by the live site itself
export const trackView = async (req, res) => {
  try {
    const ipHash = req.ip ? crypto.createHash('sha256').update(req.ip).digest('hex') : null
    await query(
      `INSERT INTO project_views (project_id, referrer, user_agent, ip_hash) VALUES (?,?,?,?)`,
      [req.params.projectId, req.body?.referrer?.slice(0,250) || null, req.headers['user-agent']?.slice(0,250) || null, ipHash]
    )
  } catch (_) {}
  res.status(204).end() // never fail visibly on the visitor's site
}

// GET /api/analytics/:projectId — owner only
export const getProjectAnalytics = async (req, res) => {
  try {
    const proj = await queryOne('SELECT id FROM projects WHERE id=? AND user_id=?', [req.params.projectId, req.user.id])
    if (!proj) return res.status(404).json({ error: 'Project not found.' })

    const totalRow = await queryOne('SELECT COUNT(*) AS total FROM project_views WHERE project_id=?', [req.params.projectId])

    const byDay = await query(
      `SELECT DATE(viewed_at) AS day, COUNT(*) AS views FROM project_views
       WHERE project_id=? AND viewed_at >= DATE_SUB(NOW(), INTERVAL 30 DAY)
       GROUP BY DATE(viewed_at) ORDER BY day ASC`, [req.params.projectId])

    const byHour = await query(
      `SELECT HOUR(viewed_at) AS hour, COUNT(*) AS views FROM project_views
       WHERE project_id=? GROUP BY HOUR(viewed_at) ORDER BY hour ASC`, [req.params.projectId])

    const peak = byHour.reduce((max, r) => (r.views > (max?.views || 0) ? r : max), null)

    res.json({ total: totalRow.total, byDay, byHour, peakHour: peak ? peak.hour : null })
  } catch (err) {
    console.error('getProjectAnalytics:', err)
    res.status(500).json({ error: 'Failed to fetch analytics.' })
  }
}