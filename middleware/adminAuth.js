import jwt    from 'jsonwebtoken'
import dotenv from 'dotenv'
import { queryOne } from '../config/db.js'
dotenv.config()

export const adminProtect = async (req, res, next) => {
  const authHeader = req.headers.authorization
  const token = authHeader?.startsWith('Bearer ') ? authHeader.split(' ')[1] : null
  if (!token) {
    return res.status(401).json({
      error: 'No admin token. Please login at /admin-login',
      code: 'NO_TOKEN'
    })
  }

  try {
    // ── No expiry check — token is valid forever ──────────────
    const decoded = jwt.verify(token, process.env.JWT_SECRET, {
      ignoreExpiration: true   // ← unlimited session
    })

    let user
    try {
      user = await queryOne('SELECT id, email, role FROM users WHERE id=?', [decoded.id])
    } catch {
      user = await queryOne('SELECT id, email FROM users WHERE id=?', [decoded.id])
    }

    if (!user) return res.status(401).json({ error: 'Admin user not found.', code: 'NOT_FOUND' })

    const role = user.role || decoded.role
    if (role !== 'admin') return res.status(403).json({ error: 'Admin access required.', code: 'NOT_ADMIN' })

    req.user = { ...decoded, ...user }
    next()
  } catch (err) {
    return res.status(401).json({
      error: 'Invalid admin token. Please login again.',
      code:  'INVALID_TOKEN'
    })
  }
}
