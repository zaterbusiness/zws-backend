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
import { createRazorpayOrder, verifyRazorpaySignature, verifyWebhookSignature } from '../config/razorpay.js'

const PACKS = {
  pack100: { credits: 100, pricePaise: 99  * 100 },
  pack200: { credits: 200, pricePaise: 179 * 100 },
}
const DEFAULT_PACK = 'pack100'
const UNLOCK_PRICE_PAISE = 1 * 100

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

    const orderData = await createRazorpayOrder({
      orderId: merchantTransactionId,
      amountPaise: UNLOCK_PRICE_PAISE,
      notes: { userId: String(req.user.id), type: 'unlock_payment' },
    })

    await query(
      `INSERT INTO payments (id, user_id, phonepe_txn_id, amount, currency, type, status)
       VALUES (UUID(), ?, ?, ?, 'INR', 'unlock_payment', 'created')`,
      [req.user.id, orderData.id, UNLOCK_PRICE_PAISE]
    )

    res.json({
      razorpayOrderId: orderData.id,
      razorpayKeyId: process.env.RAZORPAY_KEY_ID,
      merchantTransactionId: orderData.id,
      amount: UNLOCK_PRICE_PAISE,
      paymentType: 'unlock_payment',
    })
  } catch (err) {
    console.error('createUnlockOrder:', err)
    res.status(500).json({ error: 'Failed to create unlock order. Please try again.' })
  }
}

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

    const orderData = await createRazorpayOrder({
      orderId: merchantTransactionId,
      amountPaise: pack.pricePaise,
      notes: { userId: String(req.user.id), type: 'credit_purchase', plan: planKey },
    })

    await query(
      `INSERT INTO payments (id, user_id, phonepe_txn_id, amount, currency, type, status)
       VALUES (UUID(), ?, ?, ?, 'INR', 'credit_purchase', 'created')`,
      [req.user.id, orderData.id, pack.pricePaise]
    )

    res.json({
      razorpayOrderId: orderData.id,
      razorpayKeyId: process.env.RAZORPAY_KEY_ID,
      merchantTransactionId: orderData.id,
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

// POST /api/credits/verify
export const verifyAndFinalize = async (req, res) => {
  const { razorpay_order_id, razorpay_payment_id, razorpay_signature } = req.body
  try {
    if (await isDuplicatePayment(razorpay_order_id)) {
      return res.json({ status: 'already_processed' })
    }

    const payment = await queryOne(
      'SELECT * FROM payments WHERE phonepe_txn_id=? AND user_id=?',
      [razorpay_order_id, req.user.id]
    )
    if (!payment) return res.status(404).json({ error: 'Payment record not found.' })

    const valid = verifyRazorpaySignature({
      orderId: razorpay_order_id,
      paymentId: razorpay_payment_id,
      signature: razorpay_signature,
    })

    if (!valid) {
      await query('UPDATE payments SET status=? WHERE phonepe_txn_id=?', ['failed', razorpay_order_id])
      return res.json({ status: 'failed', message: 'Signature verification failed.' })
    }

    if (payment.type === 'unlock_payment') {
      await query('UPDATE users SET has_paid = 1 WHERE id=?', [req.user.id])
      const currentUser = await queryOne('SELECT credits FROM users WHERE id=?', [req.user.id])

      try {
        await query(
          `INSERT INTO credit_transactions (user_id, type, amount, reason, ref_id, balance_after)
           VALUES (?, 'unlock', 0, 'unlock_payment', ?, ?)`,
          [req.user.id, razorpay_order_id, currentUser.credits]
        )
      } catch {}

      await query('UPDATE payments SET razorpay_payment_id=?, status=? WHERE phonepe_txn_id=?', [razorpay_payment_id, 'paid', razorpay_order_id])

      return res.json({
        status: 'paid',
        message: 'Download and hosting unlocked successfully!',
        has_paid: true,
        credits: currentUser.credits,
      })
    }

    if (payment.type === 'credit_purchase') {
      const planKey = Object.keys(PACKS).find(k => PACKS[k].pricePaise === payment.amount) || DEFAULT_PACK
      const creditsToAdd = PACKS[planKey].credits

      await query('UPDATE users SET credits = credits + ? WHERE id=?', [creditsToAdd, req.user.id])
      const updatedUser = await queryOne('SELECT credits FROM users WHERE id=?', [req.user.id])

      try {
        await query(
          `INSERT INTO credit_transactions (user_id, type, amount, reason, ref_id, balance_after)
           VALUES (?, 'earn', ?, 'credit_purchase', ?, ?)`,
          [req.user.id, creditsToAdd, razorpay_order_id, updatedUser.credits]
        )
      } catch {}

      await query('UPDATE payments SET razorpay_payment_id=?, status=? WHERE phonepe_txn_id=?', [razorpay_payment_id, 'paid', razorpay_order_id])

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
    console.error('verifyAndFinalize:', err)
    res.status(500).json({ error: 'Failed to verify payment. Contact support.' })
  }
}
// ─────────────────────────────────────────────────────────────
// POST /api/credits/webhook — PhonePe server-to-server callback
// (no auth middleware — PhonePe calls this directly)
// ─────────────────────────────────────────────────────────────
// webhook handler rename
export const razorpayWebhook = async (req, res) => {
  const signature = req.headers['x-razorpay-signature']
  const valid = verifyWebhookSignature(JSON.stringify(req.body), signature)
  if (!valid) return res.status(400).json({ error: 'Invalid signature' })
  console.log('📩 Razorpay webhook:', req.body.event)
  res.status(200).json({ received: true })
}