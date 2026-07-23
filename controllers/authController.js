import bcrypt     from 'bcryptjs'
import jwt        from 'jsonwebtoken'
import crypto     from 'crypto'
import nodemailer from 'nodemailer'
import { query, queryOne } from '../config/db.js'
import { OAuth2Client } from 'google-auth-library'

const AVATARS = ['🧑‍💻','👩‍💻','🦄','🚀','⚡','🎯','🔥','💎','🌟','🎨','🦋','🏆']
const SIGNUP_CREDITS = 100  // every new user gets 100 free credits

// ── Admin email check ─────────────────────────────────────────
const isAdminEmail = (email) =>
  email.toLowerCase().trim() === (process.env.ADMIN_EMAIL || '').toLowerCase().trim()

// ── JWT ───────────────────────────────────────────────────────
const signToken = (user) =>
  jwt.sign(
    { id: user.id, email: user.email, name: user.name, role: user.role || 'user' },
    process.env.JWT_SECRET,
    { expiresIn: '7d' }
  )

const safeUser = (user) => ({
  id:         user.id,
  name:       user.name,
  email:      user.email,
  avatar:     user.avatar,
  plan:       user.plan,
  role:       user.role || 'user',
  credits:    user.credits ?? SIGNUP_CREDITS,
  created_at: user.created_at,
})

// ── Strong password validator ─────────────────────────────────
const validatePassword = (password) => {
  const errors = []
  if (password.length < 8)              errors.push('at least 8 characters')
  if (!/[A-Z]/.test(password))          errors.push('one uppercase letter (A-Z)')
  if (!/[a-z]/.test(password))          errors.push('one lowercase letter (a-z)')
  if (!/[0-9]/.test(password))          errors.push('one number (0-9)')
  if (!/[!@#$%^&*()_+\-=\[\]{};':"\\|,.<>\/?]/.test(password))
                                         errors.push('one special character (!@#$%^&*...)')
  return errors
}

// ── Nodemailer transporter ────────────────────────────────────
const createTransporter = () =>
  nodemailer.createTransport({
    host:   process.env.SMTP_HOST || 'smtp.gmail.com',
    port:   Number(process.env.SMTP_PORT) || 587,
    secure: false,
    auth:   { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
    tls:    { rejectUnauthorized: false },
  })

// ── POST /api/auth/signup ────────────────────────────────────
export const signup = async (req, res) => {
  try {
    const { name, email, password, phone } = req.body

    if (!name?.trim() || !email?.trim() || !password)
      return res.status(400).json({ error: 'Name, email and password are required.' })
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
      return res.status(400).json({ error: 'Please enter a valid email address.' })

    const pwErrors = validatePassword(password)
    if (pwErrors.length > 0)
      return res.status(400).json({ error: `Password must have: ${pwErrors.join(', ')}.`, passwordErrors: pwErrors })

    const existing = await queryOne('SELECT id FROM users WHERE email=?', [email.toLowerCase()])
    if (existing)
      return res.status(409).json({ error: 'This email is already registered. Please log in.' })

    const hashedPassword = await bcrypt.hash(password, 12)
    const avatar = AVATARS[Math.floor(Math.random() * AVATARS.length)]
    const role   = isAdminEmail(email) ? 'admin' : 'user'   // ← auto-assign admin role

    const result = await query(
      'INSERT INTO users (name, email, password, avatar, phone, credits, role) VALUES (?,?,?,?,?,?,?)',
      [name.trim(), email.toLowerCase(), hashedPassword, avatar, phone || null, SIGNUP_CREDITS, role]
    )

    // Log signup bonus (non-blocking)
    query('INSERT INTO credit_transactions (user_id, type, amount, reason, balance_after) VALUES (?,?,?,?,?)',
      [result.insertId, 'earn', SIGNUP_CREDITS, 'signup_bonus', SIGNUP_CREDITS]).catch(() => {})

    const newUser = await queryOne('SELECT * FROM users WHERE id=?', [result.insertId])
    const token   = signToken(newUser)

    console.log(`✅ New user: ${email} (+${SIGNUP_CREDITS} credits) [role: ${role}]`)
    res.status(201).json({ token, user: safeUser(newUser) })
  } catch (err) {
    console.error('signup:', err)
    res.status(500).json({ error: 'Registration failed. Please try again.' })
  }
}

// ── POST /api/auth/login ─────────────────────────────────────
export const login = async (req, res) => {
  try {
    const { email, password } = req.body
    if (!email?.trim() || !password)
      return res.status(400).json({ error: 'Email and password are required.' })

    const user = await queryOne('SELECT * FROM users WHERE email=?', [email.toLowerCase()])
    if (!user)
      return res.status(401).json({ error: 'Invalid email or password.' })

    const isValid = await bcrypt.compare(password, user.password)
    if (!isValid)
      return res.status(401).json({ error: 'Invalid email or password.' })

    // Sync role in DB if it doesn't match ADMIN_EMAIL (handles existing accounts)
    if (isAdminEmail(email) && user.role !== 'admin') {
      await query('UPDATE users SET role=? WHERE id=?', ['admin', user.id])
      user.role = 'admin'
      console.log(`🔐 Admin role synced for: ${email}`)
    }

    const token = signToken(user)
    console.log(`✅ Login: ${email} [role: ${user.role}]`)
    res.json({ token, user: safeUser(user) })
  } catch (err) {
    console.error('login:', err)
    res.status(500).json({ error: 'Login failed. Please try again.' })
  }
}

// ── GET /api/auth/me ─────────────────────────────────────────
export const getMe = async (req, res) => {
  try {
    const user = await queryOne(
      'SELECT id, name, email, avatar, plan, role, credits, created_at FROM users WHERE id=?',
      [req.user.id]
    )
    if (!user) return res.status(404).json({ error: 'User not found.' })
    res.json({ user: safeUser(user) })
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch user.' })
  }
}

// ── GET /api/auth/credits — lightweight credit balance check ──
export const getCredits = async (req, res) => {
  try {
    const row = await queryOne('SELECT credits FROM users WHERE id=?', [req.user.id])
    if (!row) return res.status(404).json({ error: 'User not found.' })
    res.json({ credits: row.credits })
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch credits.' })
  }
}

// ── POST /api/auth/forgot-password ──────────────────────────
export const forgotPassword = async (req, res) => {
  try {
    const { email } = req.body
    if (!email?.trim())
      return res.status(400).json({ error: 'Email is required.' })

    const user = await queryOne('SELECT * FROM users WHERE email=?', [email.toLowerCase()])
    if (!user)
      return res.json({ message: 'If that email exists, a reset link has been sent.' })

    const token     = crypto.randomBytes(32).toString('hex')
    const expiresAt = new Date(Date.now() + 60 * 60 * 1000)

    await query('DELETE FROM password_reset_tokens WHERE user_id=?', [user.id])
    await query(
      'INSERT INTO password_reset_tokens (user_id, token, expires_at) VALUES (?,?,?)',
      [user.id, token, expiresAt]
    )

    const resetUrl    = `${process.env.FRONTEND_URL}/reset-password?token=${token}`
    const transporter = createTransporter()
    await transporter.sendMail({
      from:    `"Zater Web Studio" <${process.env.SMTP_USER}>`,
      to:      user.email,
      subject: 'Reset your Zater password',
      html: `<body style="font-family:system-ui;background:#f4f4f8;margin:0;padding:20px;">
        <div style="max-width:480px;margin:0 auto;background:#fff;border-radius:16px;overflow:hidden;">
          <div style="background:#0a0a12;padding:24px;text-align:center;">
            <h1 style="color:#fff;margin:0;font-size:20px;">Zater Web Studio</h1>
          </div>
          <div style="padding:32px;">
            <h2 style="color:#0a0a12;margin:0 0 8px;">Reset your password</h2>
            <p style="color:#72727f;font-size:14px;line-height:1.6;">Hi <strong>${user.name}</strong>,</p>
            <p style="color:#72727f;font-size:14px;">Click the button below to reset your password. This link expires in 1 hour.</p>
            <a href="${resetUrl}" style="display:block;background:#c0392b;color:#fff;text-decoration:none;text-align:center;padding:14px;border-radius:10px;font-size:15px;font-weight:800;margin:24px 0;">Reset My Password</a>
            <p style="color:#a0a0b0;font-size:12px;">If you didn't request this, ignore this email.</p>
          </div>
        </div></body>`,
    })

    console.log(`📧 Password reset sent to: ${email}`)
    res.json({ message: 'Password reset link sent to your email.' })
  } catch (err) {
    console.error('forgotPassword:', err)
    res.status(500).json({ error: 'Failed to send reset email. Please try again.' })
  }
}

// ── POST /api/auth/reset-password ───────────────────────────
export const resetPassword = async (req, res) => {
  try {
    const { token, password } = req.body
    if (!token || !password)
      return res.status(400).json({ error: 'Token and new password are required.' })

    const pwErrors = validatePassword(password)
    if (pwErrors.length > 0)
      return res.status(400).json({ error: `Password must have: ${pwErrors.join(', ')}.`, passwordErrors: pwErrors })

    const resetToken = await queryOne(
      `SELECT * FROM password_reset_tokens WHERE token=? AND used=0 AND expires_at > NOW()`,
      [token]
    )
    if (!resetToken)
      return res.status(400).json({ error: 'Reset link is invalid or has expired. Please request a new one.' })

    const hashedPassword = await bcrypt.hash(password, 12)
    await query('UPDATE users SET password=? WHERE id=?', [hashedPassword, resetToken.user_id])
    await query('UPDATE password_reset_tokens SET used=1 WHERE id=?', [resetToken.id])

    console.log(`✅ Password reset for user ${resetToken.user_id}`)
    res.json({ message: 'Password reset successfully. You can now log in.' })
  } catch (err) {
    console.error('resetPassword:', err)
    res.status(500).json({ error: 'Reset failed. Please try again.' })
  }
}

// ── POST /api/auth/validate-reset-token ─────────────────────
export const validateResetToken = async (req, res) => {
  try {
    const { token } = req.body
    const resetToken = await queryOne(
      `SELECT id FROM password_reset_tokens WHERE token=? AND used=0 AND expires_at > NOW()`,
      [token]
    )
    res.json({ valid: !!resetToken })
  } catch {
    res.status(500).json({ valid: false })
  }
}

// ── POST /api/auth/google ─────────────────────────────────────
export const googleAuth = async (req, res) => {
  try {
    const { credential } = req.body
    if (!credential) return res.status(400).json({ error: 'Google credential required.' })

    const clientId = process.env.GOOGLE_CLIENT_ID
    if (!clientId || clientId.includes('your_google'))
      return res.status(500).json({ error: 'Google Client ID not configured in .env' })

    const client  = new OAuth2Client(clientId)
    const ticket  = await client.verifyIdToken({ idToken: credential, audience: clientId })
    const payload = ticket.getPayload()
    const { email, name, picture, sub: googleId } = payload

    if (!email) return res.status(400).json({ error: 'Could not get email from Google account.' })

    let user = await queryOne('SELECT * FROM users WHERE email=?', [email.toLowerCase()])

    if (user) {
      // Sync role if this is the admin email and role is wrong
      const correctRole = isAdminEmail(email) ? 'admin' : user.role
      await query('UPDATE users SET name=?, google_id=?, role=? WHERE id=?',
        [user.name || name, googleId, correctRole, user.id])
      user = await queryOne('SELECT * FROM users WHERE id=?', [user.id])
    } else {
      // New Google user
      const avatar = picture || '🌟'
      const role   = isAdminEmail(email) ? 'admin' : 'user'   // ← auto-assign admin role
      await query(
        `INSERT INTO users (name, email, password, avatar, google_id, credits, role) VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [name, email.toLowerCase(), '', avatar, googleId, SIGNUP_CREDITS, role]
      )
      user = await queryOne('SELECT * FROM users WHERE email=?', [email.toLowerCase()])
      query('INSERT INTO credit_transactions (user_id, type, amount, reason, balance_after) VALUES (?,?,?,?,?)',
        [user.id, 'earn', SIGNUP_CREDITS, 'signup_bonus', SIGNUP_CREDITS]).catch(() => {})
      console.log(`✅ New Google user: ${email} (+${SIGNUP_CREDITS} credits) [role: ${role}]`)
    }

    if (user.status === 'paused')
      return res.status(403).json({ error: 'Your account has been paused. Contact support.' })

    const token = signToken(user)
    console.log(`✅ Google login: ${email} [role: ${user.role}]`)
    res.json({ token, user: safeUser(user) })
  } catch (err) {
    console.error('googleAuth:', err)
    if (err.message?.includes('Token used too late') || err.message?.includes('expired'))
      return res.status(401).json({ error: 'Google session expired. Please try again.' })
    res.status(500).json({ error: 'Google login failed. Please try again.' })
  }
}