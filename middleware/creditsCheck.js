// middleware/creditCheck.js

import { query, queryOne } from '../config/db.js'

const CREDITS_PER_GENERATION = 100

// ── checkCreditsOnly ──────────────────────────────────────────
// Only checks balance, does NOT deduct. Sets req.creditChecked = true.
// Deduction happens AFTER successful generation via deductAfterSuccess()
export const checkCreditsOnly = (amount = CREDITS_PER_GENERATION) => async (req, res, next) => {
  const userId = req.user?.id
  if (!userId) return res.status(401).json({ error: 'Unauthorized.' })

  try {
    const user = await queryOne('SELECT credits FROM users WHERE id=?', [userId])
    if (!user) return res.status(404).json({ error: 'User not found.' })

    if (user.credits < amount) {
      return res.status(402).json({
        error: 'Insufficient credits. Please purchase more credits.',
        code: 'INSUFFICIENT_CREDITS',
        currentCredits: user.credits,
        required: amount,
      })
    }

    req.creditAmount = amount
    req.creditUserId = userId
    next()
  } catch (err) {
    console.error('checkCreditsOnly middleware:', err)
    return res.status(500).json({ error: 'Credit check failed. Please try again.' })
  }
}

// ── deductAfterSuccess ────────────────────────────────────────
// Call this INSIDE the controller after AI generation succeeds.
export const deductAfterSuccess = async (userId, amount) => {
  await query(
    'UPDATE users SET credits = credits - ? WHERE id=? AND credits >= ?',
    [amount, userId, amount]
  )

  const updated = await queryOne('SELECT credits FROM users WHERE id=?', [userId])
  const newBalance = updated?.credits ?? 0

  query(
    `INSERT INTO credit_transactions (user_id, type, amount, reason, balance_after)
     VALUES (?, 'spend', ?, 'ai_generation', ?)`,
    [userId, amount, newBalance]
  ).catch(() => {})

  console.log(`💳 Credits deducted post-generation: user ${userId} -${amount} → balance ${newBalance}`)
  return newBalance
}

// ── deductCredits ─────────────────────────────────────────────
// Original pre-deduct middleware (kept for non-generation routes)
export const deductCredits = (amount = CREDITS_PER_GENERATION) => async (req, res, next) => {
  const userId = req.user?.id
  if (!userId) return res.status(401).json({ error: 'Unauthorized.' })

  try {
    const user = await queryOne('SELECT credits FROM users WHERE id=?', [userId])
    if (!user) return res.status(404).json({ error: 'User not found.' })

    if (user.credits < amount) {
      return res.status(402).json({
        error: 'Insufficient credits. Please purchase more credits.',
        code: 'INSUFFICIENT_CREDITS',
        currentCredits: user.credits,
        required: amount,
      })
    }

    await query(
      'UPDATE users SET credits = credits - ? WHERE id=? AND credits >= ?',
      [amount, userId, amount]
    )

    const updated = await queryOne('SELECT credits FROM users WHERE id=?', [userId])
    const newBalance = updated.credits

    query(
      `INSERT INTO credit_transactions (user_id, type, amount, reason, balance_after)
       VALUES (?, 'spend', ?, 'ai_generation', ?)`,
      [userId, amount, newBalance]
    ).catch(() => {})

    req.creditsDeducted = amount
    req.creditsBalance = newBalance

    console.log(`💳 Credits deducted: user ${userId} -${amount} → balance ${newBalance}`)
    next()
  } catch (err) {
    console.error('deductCredits middleware:', err)
    return res.status(500).json({ error: 'Credit check failed. Please try again.' })
  }
}

// ── requirePayment ────────────────────────────────────────────
export const requirePayment = async (req, res, next) => {
  const userId = req.user?.id
  if (!userId) return res.status(401).json({ error: 'Unauthorized.' })

  try {
    const user = await queryOne('SELECT has_paid FROM users WHERE id=?', [userId])
    if (!user) return res.status(404).json({ error: 'User not found.' })

    if (!user.has_paid) {
      return res.status(403).json({
        error: 'Please complete the ₹99 unlock payment to enable downloads and hosting.',
        code: 'PAYMENT_REQUIRED',
      })
    }

    next()
  } catch (err) {
    console.error('requirePayment middleware:', err)
    return res.status(500).json({ error: 'Could not verify payment status.' })
  }
}