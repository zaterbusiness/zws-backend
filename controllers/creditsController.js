/**
 * creditsController.js — PhonePe version
 *
 *  1. UNLOCK PAYMENT (first time, ₹99)
 *     POST /api/credits/unlock/order   — create order, returns redirectUrl
 *     GET  /api/credits/status/:merchantTransactionId — check + finalize
 *
 *  2. CREDIT PURCHASE
 *     POST /api/credits/purchase/order  — create order, returns redirectUrl
 *     GET  /api/credits/status/:merchantTransactionId — check + finalize (shared with unlock)
 *
 *  GET /api/credits — balance + has_paid + history
 */

import { query, queryOne } from '../config/db.js'
import { initiatePhonePePayment, checkPhonePeStatus } from '../config/phonepe.js'

const PACKS = {
  pack100: { credits: 100, pricePaise: 99  * 100 },
  pack200: { credits: 200, pricePaise: 179 * 100 },
}
const DEFAULT_PACK = 'pack100'
const UNLOCK_PRICE_PAISE = 99 * 100

const FRONTEND_URL = process.env.FRONTEND_URL || 'http://localhost:5173'
const BACKEND_URL  = process.env.BACKEND_URL  || 'http://localhost:5000'

const isDuplicatePayment = async (merchantTransactionId) => {
  const row = await queryOne(
    'SELECT id FROM payments WHERE phonepe_txn_id=? AND status=?',
    [merchantTransactionId, 'paid']
  )
  return !!row
}

// ─────────────────────────────────────────────────────────────
// GET /api/credits
// ─────────────────────────────────────────────────────────────
export const getCreditsInfo = async (req, res) => {
  try {
    const user = await queryOne('SELECT credits, has_paid FROM users WHERE id=?', [req.user.id])
    if (!user) return res.status(404).json({ error: 'User not found.' })

    let history = []
    try {
      history = await query(
        `SELECT type, amount, reason, ref_id, balance_after, created_at
         FROM credit_transactions WHERE user_id=? ORDER BY created_at DESC LIMIT 20`,
        [req.user.id]
      )
    } catch {}

    res.json({ credits: user.credits, has_paid: !!user.has_paid, history })
  } catch (err) {
    console.error('getCreditsInfo:', err)
    res.status(500).json({ error: 'Failed to fetch credits.' })
  }
}

// ─────────────────────────────────────────────────────────────
// FLOW 1 — UNLOCK PAYMENT (₹99 → has_paid=1)
// ─────────────────────────────────────────────────────────────

// POST /api/credits/unlock/order
export const createUnlockOrder = async (req, res) => {
  try {
    const user = await queryOne('SELECT has_paid FROM users WHERE id=?', [req.user.id])
    if (user?.has_paid) {
      return res.status(400).json({
        error: 'Download and hosting are already unlocked on your account.',
        code:  'ALREADY_UNLOCKED',
      })
    }

    const merchantTransactionId = `unlock_${req.user.id}_${Date.now()}`

    const { redirectUrl } = await initiatePhonePePayment({
      amountPaise: UNLOCK_PRICE_PAISE,
      merchantUserId: String(req.user.id),
      merchantTransactionId,
      redirectUrl: `${FRONTEND_URL}/payment/callback?type=unlock&txn=${merchantTransactionId}`,
      callbackUrl: `${BACKEND_URL}/api/credits/webhook`,
    })

    await query(
      `INSERT INTO payments (id, user_id, phonepe_txn_id, amount, currency, type, status)
       VALUES (UUID(), ?, ?, ?, 'INR', 'unlock_payment', 'created')`,
      [req.user.id, merchantTransactionId, UNLOCK_PRICE_PAISE]
    )

    res.json({
      redirectUrl,
      merchantTransactionId,
      amount: UNLOCK_PRICE_PAISE,
      paymentType: 'unlock_payment',
    })
  } catch (err) {
    console.error('createUnlockOrder:', err)
    res.status(500).json({ error: 'Failed to create unlock order. Please try again.' })
  }
}

// ─────────────────────────────────────────────────────────────
// FLOW 2 — CREDIT PURCHASE
// ─────────────────────────────────────────────────────────────

// POST /api/credits/purchase/order
export const createCreditOrder = async (req, res) => {
  try {
    const user = await queryOne('SELECT has_paid FROM users WHERE id=?', [req.user.id])
    if (!user?.has_paid) {
      return res.status(403).json({
        error: 'Please complete the ₹99 unlock payment before purchasing credits.',
        code:  'UNLOCK_REQUIRED',
      })
    }

    const planKey = PACKS[req.body?.plan] ? req.body.plan : DEFAULT_PACK
    const pack     = PACKS[planKey]
    const merchantTransactionId = `cr_${req.user.id}_${Date.now()}`

    const { redirectUrl } = await initiatePhonePePayment({
      amountPaise: pack.pricePaise,
      merchantUserId: String(req.user.id),
      merchantTransactionId,
      redirectUrl: `${FRONTEND_URL}/payment/callback?type=credit&plan=${planKey}&txn=${merchantTransactionId}`,
      callbackUrl: `${BACKEND_URL}/api/credits/webhook`,
    })

    await query(
      `INSERT INTO payments (id, user_id, phonepe_txn_id, amount, currency, type, status)
       VALUES (UUID(), ?, ?, ?, 'INR', 'credit_purchase', 'created')`,
      [req.user.id, merchantTransactionId, pack.pricePaise]
    )

    res.json({
      redirectUrl,
      merchantTransactionId,
      amount: pack.pricePaise,
      creditsToAdd: pack.credits,
      plan: planKey,
      paymentType: 'credit_purchase',
    })
  } catch (err) {
    console.error('createCreditOrder:', err)
    res.status(500).json({ error: 'Failed to create credit order. Please try again.' })
  }
}

// ─────────────────────────────────────────────────────────────
// GET /api/credits/status/:merchantTransactionId
// Called by the frontend callback page after PhonePe redirects back.
// This is the "verify" step — no signature from the client anymore.
// ─────────────────────────────────────────────────────────────
export const checkPaymentStatus = async (req, res) => {
  const { merchantTransactionId } = req.params
  try {
    if (await isDuplicatePayment(merchantTransactionId)) {
      return res.json({ status: 'already_processed' })
    }

    const payment = await queryOne(
      'SELECT * FROM payments WHERE phonepe_txn_id=? AND user_id=?',
      [merchantTransactionId, req.user.id]
    )
    if (!payment) return res.status(404).json({ error: 'Payment record not found.' })

    const statusRes = await checkPhonePeStatus(merchantTransactionId)

    if (statusRes?.code !== 'PAYMENT_SUCCESS') {
      await query('UPDATE payments SET status=? WHERE phonepe_txn_id=?', ['failed', merchantTransactionId])
      return res.json({ status: 'failed', message: statusRes?.message || 'Payment not completed.' })
    }

    // ── Finalize based on payment type ──
    if (payment.type === 'unlock_payment') {
      await query('UPDATE users SET has_paid = 1 WHERE id=?', [req.user.id])
      const currentUser = await queryOne('SELECT credits FROM users WHERE id=?', [req.user.id])

      try {
        await query(
          `INSERT INTO credit_transactions (user_id, type, amount, reason, ref_id, balance_after)
           VALUES (?, 'unlock', 0, 'unlock_payment', ?, ?)`,
          [req.user.id, merchantTransactionId, currentUser.credits]
        )
      } catch {}

      await query('UPDATE payments SET status=? WHERE phonepe_txn_id=?', ['paid', merchantTransactionId])

      return res.json({
        status: 'paid',
        message: 'Download and hosting unlocked successfully!',
        has_paid: true,
        credits: currentUser.credits,
      })
    }

    if (payment.type === 'credit_purchase') {
      // credits amount was fixed at order-creation time; re-derive from stored `amount`
      const planKey = Object.keys(PACKS).find(k => PACKS[k].pricePaise === payment.amount) || DEFAULT_PACK
      const creditsToAdd = PACKS[planKey].credits

      await query('UPDATE users SET credits = credits + ? WHERE id=?', [creditsToAdd, req.user.id])
      const updatedUser = await queryOne('SELECT credits FROM users WHERE id=?', [req.user.id])

      try {
        await query(
          `INSERT INTO credit_transactions (user_id, type, amount, reason, ref_id, balance_after)
           VALUES (?, 'earn', ?, 'credit_purchase', ?, ?)`,
          [req.user.id, creditsToAdd, merchantTransactionId, updatedUser.credits]
        )
      } catch {}

      await query('UPDATE payments SET status=? WHERE phonepe_txn_id=?', ['paid', merchantTransactionId])

      return res.json({
        status: 'paid',
        message: `${creditsToAdd} credits added to your account!`,
        creditsAdded: creditsToAdd,
        newBalance: updatedUser.credits,
        has_paid: true,
      })
    }

    res.status(400).json({ error: 'Unknown payment type.' })
  } catch (err) {
    console.error('checkPaymentStatus:', err)
    res.status(500).json({ error: 'Failed to verify payment. Contact support.' })
  }
}

// ─────────────────────────────────────────────────────────────
// POST /api/credits/webhook — PhonePe server-to-server callback
// (no auth middleware — PhonePe calls this directly)
// ─────────────────────────────────────────────────────────────
export const phonepeWebhook = async (req, res) => {
  // PhonePe posts a base64-encoded response body; you can log/audit here.
  // Actual finalization still happens via checkPaymentStatus so it's tied to
  // an authenticated user session — this just acknowledges receipt.
  console.log('📩 PhonePe webhook received:', req.body)
  res.status(200).json({ received: true })
}