import { query, queryOne } from '../config/db.js'
import fs   from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const UPLOADS   = path.join(__dirname, '..', 'uploads', 'ads')
try { fs.mkdirSync(UPLOADS, { recursive: true }) } catch {}

// ── GET /api/ads/active — public, no auth ─────────────────────
// Called by Home.jsx on mount. Returns the active ad and tracks the page view.
export const getActiveAd = async (req, res) => {
  try {
    // Try to get an ad marked active first; fall back to most recent if none
    let ad = await queryOne(
      `SELECT id, title, image_url, link_url, link_text
       FROM ads WHERE is_active = 1
       ORDER BY updated_at DESC LIMIT 1`
    )
    if (!ad) {
      ad = await queryOne(
        `SELECT id, title, image_url, link_url, link_text
         FROM ads ORDER BY created_at DESC LIMIT 1`
      )
    }
    if (!ad) return res.json({ ad: null })

    // Increment view count on the ad
    try {
      await query('UPDATE ads SET views = views + 1 WHERE id = ?', [ad.id])
    } catch {}

    // Log page view (ignore errors if table doesn't exist yet)
    try {
      const ip        = (req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.ip || '').slice(0, 64)
      const userAgent = (req.headers['user-agent'] || '').slice(0, 500)
      const userId    = req.user?.id ?? null
      await query(
        'INSERT INTO page_views (page, user_id, ip, user_agent) VALUES (?, ?, ?, ?)',
        ['home', userId, ip, userAgent]
      )
    } catch {}

    res.json({ ad })
  } catch (err) {
    console.error('getActiveAd error:', err.message)
    res.json({ ad: null })   // never crash the homepage
  }
}

// ── POST /api/ads/click/:id — called only when user CLICKS the ad CTA ────────
export const recordAdClick = async (req, res) => {
  try {
    await query('UPDATE ads SET clicks = clicks + 1 WHERE id = ?', [req.params.id])
    res.json({ ok: true })
  } catch {
    res.json({ ok: true })   // silent fail — never block the user
  }
}

// ── POST /api/ads/page-view — legacy route kept for compatibility ─────────────
export const recordPageView = async (req, res) => {
  try {
    const ip        = (req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.ip || '').slice(0, 64)
    const userAgent = (req.headers['user-agent'] || '').slice(0, 500)
    const userId    = req.user?.id ?? req.body?.userId ?? null
    const page      = req.body?.page || '/'
    try {
      await query(
        'INSERT INTO page_views (page, user_id, ip, user_agent) VALUES (?, ?, ?, ?)',
        [page, userId, ip, userAgent]
      )
    } catch {}
    res.json({ ok: true })
  } catch {
    res.json({ ok: true })
  }
}

// ── GET /api/admin/ads — admin only ──────────────────────────
export const getAds = async (req, res) => {
  try {
    const ads = await query('SELECT * FROM ads ORDER BY created_at DESC')
    res.json({ ads })
  } catch (err) {
    console.error('getAds error:', err.message)
    res.status(500).json({ error: 'Failed to fetch ads.' })
  }
}

// ── POST /api/admin/ads — create ad ──────────────────────────
// New ads default to is_active = 1 so they show on homepage immediately.
export const createAd = async (req, res) => {
  try {
    const { title, imageBase64, imageType, link_url, link_text, is_active } = req.body
    if (!title?.trim()) return res.status(400).json({ error: 'Title is required.' })

    // Save uploaded image if provided
    let image_url = ''
    if (imageBase64 && imageType) {
      const ext  = (imageType.split('/')[1] || 'jpg').replace('jpeg', 'jpg')
      const name = `ad_${Date.now()}.${ext}`
      const buf  = Buffer.from(imageBase64.replace(/^data:image\/\w+;base64,/, ''), 'base64')
      fs.writeFileSync(path.join(UPLOADS, name), buf)
      image_url = `/uploads/ads/${name}`
    }

    // is_active defaults to 1 (active) — admin can deactivate later
    const activeFlag = is_active !== undefined ? (is_active ? 1 : 0) : 1

    const result = await query(
      'INSERT INTO ads (title, image_url, link_url, link_text, is_active) VALUES (?, ?, ?, ?, ?)',
      [title.trim(), image_url, link_url || '', link_text || 'Learn More', activeFlag]
    )
    res.json({ message: 'Ad created and activated.', adId: result.insertId })
  } catch (err) {
    console.error('createAd error:', err.message)
    res.status(500).json({ error: 'Failed to create ad.' })
  }
}

// ── PUT /api/admin/ads/:id — update ad ───────────────────────
export const updateAd = async (req, res) => {
  try {
    const { title, imageBase64, imageType, link_url, link_text, is_active } = req.body
    const ad = await queryOne('SELECT * FROM ads WHERE id = ?', [req.params.id])
    if (!ad) return res.status(404).json({ error: 'Ad not found.' })

    let image_url = ad.image_url
    if (imageBase64 && imageType) {
      const ext  = (imageType.split('/')[1] || 'jpg').replace('jpeg', 'jpg')
      const name = `ad_${Date.now()}.${ext}`
      const buf  = Buffer.from(imageBase64.replace(/^data:image\/\w+;base64,/, ''), 'base64')
      fs.writeFileSync(path.join(UPLOADS, name), buf)
      image_url = `/uploads/ads/${name}`
    }

    const activeFlag = is_active !== undefined ? (is_active ? 1 : 0) : ad.is_active

    await query(
      'UPDATE ads SET title = ?, image_url = ?, link_url = ?, link_text = ?, is_active = ? WHERE id = ?',
      [
        title?.trim() || ad.title,
        image_url,
        link_url  ?? ad.link_url,
        link_text ?? ad.link_text,
        activeFlag,
        req.params.id,
      ]
    )
    res.json({ message: 'Ad updated.' })
  } catch (err) {
    console.error('updateAd error:', err.message)
    res.status(500).json({ error: 'Failed to update ad.' })
  }
}

// ── DELETE /api/admin/ads/:id ─────────────────────────────────
export const deleteAd = async (req, res) => {
  try {
    const ad = await queryOne('SELECT image_url FROM ads WHERE id = ?', [req.params.id])
    if (ad?.image_url) {
      try { fs.unlinkSync(path.join(__dirname, '..', ad.image_url)) } catch {}
    }
    await query('DELETE FROM ads WHERE id = ?', [req.params.id])
    res.json({ message: 'Ad deleted.' })
  } catch (err) {
    console.error('deleteAd error:', err.message)
    res.status(500).json({ error: 'Failed to delete ad.' })
  }
}

// ── GET /api/admin/views — analytics dashboard ────────────────
export const getViewStats = async (req, res) => {
  try {
    const [[{ totalViews }]]   = [await query('SELECT COUNT(*) AS totalViews FROM page_views')]
    const [[{ todayViews }]]   = [await query(`SELECT COUNT(*) AS todayViews FROM page_views WHERE DATE(viewed_at) = CURDATE()`)]
    const [[{ weekViews }]]    = [await query(`SELECT COUNT(*) AS weekViews  FROM page_views WHERE viewed_at >= DATE_SUB(NOW(), INTERVAL 7 DAY)`)]
    const [[{ monthViews }]]   = [await query(`SELECT COUNT(*) AS monthViews FROM page_views WHERE viewed_at >= DATE_SUB(NOW(), INTERVAL 30 DAY)`)]
    const [[{ uniqueTotal }]]  = [await query(`SELECT COUNT(DISTINCT ip) AS uniqueTotal FROM page_views WHERE ip != ''`)]
    const [[{ uniqueToday }]]  = [await query(`SELECT COUNT(DISTINCT ip) AS uniqueToday FROM page_views WHERE ip != '' AND DATE(viewed_at) = CURDATE()`)]
    const [[{ uniqueWeek }]]   = [await query(`SELECT COUNT(DISTINCT ip) AS uniqueWeek  FROM page_views WHERE ip != '' AND viewed_at >= DATE_SUB(NOW(), INTERVAL 7 DAY)`)]
    const [[{ loggedInViews }]]= [await query(`SELECT COUNT(*) AS loggedInViews FROM page_views WHERE user_id IS NOT NULL`)]
    const [[{ guestViews }]]   = [await query(`SELECT COUNT(*) AS guestViews   FROM page_views WHERE user_id IS NULL`)]
    const [[{ activeNow }]]    = [await query(`SELECT COUNT(DISTINCT ip) AS activeNow FROM page_views WHERE viewed_at >= DATE_SUB(NOW(), INTERVAL 5 MINUTE)`)]

    const dailyChart  = await query(`
      SELECT DATE(viewed_at) AS date, COUNT(*) AS count, COUNT(DISTINCT ip) AS unique_count
      FROM page_views WHERE viewed_at >= DATE_SUB(NOW(), INTERVAL 30 DAY)
      GROUP BY DATE(viewed_at) ORDER BY date ASC`)

    const hourlyToday = await query(`
      SELECT HOUR(viewed_at) AS hour, COUNT(*) AS count
      FROM page_views WHERE DATE(viewed_at) = CURDATE()
      GROUP BY HOUR(viewed_at) ORDER BY hour ASC`)

    const adStats = await query(
      `SELECT id, title, views, clicks, is_active, created_at FROM ads ORDER BY views DESC`)

    const peakRow = await query(
      `SELECT HOUR(viewed_at) AS hour, COUNT(*) AS cnt
       FROM page_views GROUP BY HOUR(viewed_at) ORDER BY cnt DESC LIMIT 1`)

    res.json({
      totalViews:    Number(totalViews),
      todayViews:    Number(todayViews),
      weekViews:     Number(weekViews),
      monthViews:    Number(monthViews),
      uniqueTotal:   Number(uniqueTotal),
      uniqueToday:   Number(uniqueToday),
      uniqueWeek:    Number(uniqueWeek),
      loggedInViews: Number(loggedInViews),
      guestViews:    Number(guestViews),
      activeNow:     Number(activeNow),
      peakHour:      peakRow[0]?.hour ?? null,
      dailyChart,
      hourlyToday,
      adStats,
    })
  } catch (err) {
    console.error('getViewStats error:', err.message)
    res.status(500).json({ error: 'Failed to fetch analytics.' })
  }
}
