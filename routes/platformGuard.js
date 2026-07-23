// routes/platformGuard.js
// Middleware that blocks app generation when admin has disabled the platform

import { queryOne } from '../config/db.js'

export const platformGuard = async (req, res, next) => {
  try {
    const setting = await queryOne(
      "SELECT `value` FROM payment_settings WHERE `key` = 'platform_enabled'",
      []
    )

    // If row missing or value is not '1', block the request
    if (!setting || setting.value !== '1') {
      return res.status(503).json({
        error: 'platform_disabled',
        message: 'App generation is temporarily paused for maintenance. Please check back soon.',
      })
    }

    next()
  } catch (err) {
    console.error('platformGuard error:', err)
    // Fail open — don't block users if DB check fails
    next()
  }
}