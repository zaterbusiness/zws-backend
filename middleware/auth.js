import jwt    from 'jsonwebtoken'
import dotenv from 'dotenv'
import { queryOne } from '../config/db.js'
dotenv.config()

export const protect = async (req, res, next) => {
  const authHeader = req.headers.authorization
  const queryToken = req.query.token
  const token = queryToken || (authHeader?.startsWith('Bearer ') ? authHeader.split(' ')[1] : null)
  if (!token) return res.status(401).json({ error: 'No token provided. Please login.' })

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET)

    // Check user exists and is not paused
    // Use safe query that works even if status column doesn't exist yet
    let user
    try {
      user = await queryOne('SELECT id, email, role, status FROM users WHERE id=?', [decoded.id])
    } catch {
      // Fallback if status column not yet added
      user = await queryOne('SELECT id, email, role FROM users WHERE id=?', [decoded.id])
    }

    if (!user) return res.status(401).json({ error: 'User not found.' })
    if (user.status === 'paused') {
      return res.status(403).json({
        error: 'Your account has been paused. Contact support.',
        code: 'ACCOUNT_PAUSED'
      })
    }

    req.user = decoded
    next()
  } catch {
    return res.status(401).json({ error: 'Token invalid or expired. Please login again.' })
  }
}

export const authMiddleware = protect
