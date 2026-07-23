// routes/githubAuth.js  (or controllers/githubAuth.js — wherever you keep this file)
import axios from 'axios'
import { query } from '../config/db.js'

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/auth/github/connect
// Starts the GitHub OAuth flow.
// ADMIN ONLY — regular users get a 403 immediately.
// ─────────────────────────────────────────────────────────────────────────────
export const githubOAuthRedirect = (req, res) => {
  // ── ADMIN GUARD ──────────────────────────────────────────────────────────
  if (req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Only admins can connect a GitHub account.' })
  }

  // Encode the admin's user id in state so the callback knows who to update
  const state = Buffer.from(JSON.stringify({ userId: req.user.id })).toString('base64')
  const url = [
    'https://github.com/login/oauth/authorize',
    `?client_id=${process.env.GITHUB_CLIENT_ID}`,
    `&scope=repo,user`,
    `&state=${state}`,
  ].join('')

  res.redirect(url)
}

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/auth/github/callback
// GitHub redirects here after the user authorises the OAuth app.
// Saves the access token to the admin user's row.
// ─────────────────────────────────────────────────────────────────────────────
export const githubOAuthCallback = async (req, res) => {
  try {
    const { code, state } = req.query
    if (!code || !state) {
      return res.redirect(`${process.env.FRONTEND_URL || 'http://localhost:5173'}/settings?github=error&reason=missing_params`)
    }

    // Decode the userId we stored in the state param
    let userId
    try {
      ;({ userId } = JSON.parse(Buffer.from(state, 'base64').toString()))
    } catch {
      return res.redirect(`${process.env.FRONTEND_URL || 'http://localhost:5173'}/settings?github=error&reason=bad_state`)
    }

    // Exchange code → access token
    const tokenRes = await axios.post(
      'https://github.com/login/oauth/access_token',
      {
        client_id:     process.env.GITHUB_CLIENT_ID,
        client_secret: process.env.GITHUB_CLIENT_SECRET,
        code,
        redirect_uri:  process.env.GITHUB_REDIRECT_URI,
      },
      { headers: { Accept: 'application/json' } }
    )

    const accessToken = tokenRes.data.access_token
    if (!accessToken) throw new Error('No access token received from GitHub')

    // Save token to the admin's row only
    await query('UPDATE users SET github_token = ? WHERE id = ?', [accessToken, userId])

    // Redirect back to the Settings page with a success flag
    res.redirect(`${process.env.FRONTEND_URL || 'http://localhost:5173'}/settings?github=connected`)
  } catch (err) {
    console.error('githubOAuthCallback error:', err)
    res.redirect(`${process.env.FRONTEND_URL || 'http://localhost:5173'}/settings?github=error`)
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// DELETE /api/auth/github/disconnect
// ADMIN ONLY — clears the GitHub token from the admin's row.
// ─────────────────────────────────────────────────────────────────────────────
export const disconnectGithub = async (req, res) => {
  // ── ADMIN GUARD ──────────────────────────────────────────────────────────
  if (req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Only admins can disconnect GitHub.' })
  }

  try {
    await query('UPDATE users SET github_token = NULL WHERE id = ?', [req.user.id])
    res.json({ message: 'GitHub disconnected.' })
  } catch (err) {
    console.error('disconnectGithub error:', err)
    res.status(500).json({ error: 'Failed to disconnect.' })
  }
}