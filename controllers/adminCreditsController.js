// controllers/adminCreditsController.js
import { query, queryOne } from '../config/db.js'

// GET /api/admin/credits/users?search=&page=1
export const getCreditUsers = async (req, res) => {
  try {
    const search = `%${req.query.search||''}%`
    const users = await query(
      `SELECT id, name, email, credits, has_paid, created_at,
              LEFT(name,1) AS avatar
       FROM users
       WHERE (name LIKE ? OR email LIKE ?)
       ORDER BY credits DESC, created_at DESC
       LIMIT 100`,
      [search, search]
    )
    res.json({ users, total: users.length })
  } catch(err) {
    console.error('getCreditUsers:', err)
    res.status(500).json({ error: 'Failed to fetch users.' })
  }
}

// POST /api/admin/credits/adjust  — delta can be +/-
export const adjustCredits = async (req, res) => {
  try {
    const { userId, delta, reason='admin_adjustment' } = req.body
    if (!userId || delta===undefined) return res.status(400).json({ error: 'userId and delta required.' })
    const d = parseInt(delta, 10)
    if (isNaN(d) || d===0) return res.status(400).json({ error: 'delta must be a non-zero integer.' })

    await query('UPDATE users SET credits = GREATEST(0, credits + ?) WHERE id=?', [d, userId])
    const user = await queryOne('SELECT credits FROM users WHERE id=?', [userId])

    try {
      await query(
        `INSERT INTO credit_transactions (user_id, type, amount, reason, ref_id, balance_after)
         VALUES (?, ?, ?, ?, 'admin', ?)`,
        [userId, d>0?'earn':'spend', Math.abs(d), reason, user.credits]
      )
    } catch {}

    res.json({ success:true, newBalance: user.credits })
  } catch(err) {
    console.error('adjustCredits:', err)
    res.status(500).json({ error: 'Failed to adjust credits.' })
  }
}

// POST /api/admin/credits/set  — set exact value
export const setCredits = async (req, res) => {
  try {
    const { userId, credits, reason='admin_set' } = req.body
    if (userId===undefined || credits===undefined) return res.status(400).json({ error: 'userId and credits required.' })
    const val = Math.max(0, parseInt(credits, 10))

    await query('UPDATE users SET credits = ? WHERE id=?', [val, userId])

    try {
      await query(
        `INSERT INTO credit_transactions (user_id, type, amount, reason, ref_id, balance_after)
         VALUES (?, 'earn', ?, ?, 'admin', ?)`,
        [userId, val, reason, val]
      )
    } catch {}

    res.json({ success:true, newBalance: val })
  } catch(err) {
    console.error('setCredits:', err)
    res.status(500).json({ error: 'Failed to set credits.' })
  }
}