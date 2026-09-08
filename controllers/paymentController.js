import { v4 as uuidv4 } from 'uuid'
import { query, queryOne } from '../config/db.js'
import { createRazorpayOrder, verifyRazorpaySignature, verifyWebhookSignature } from '../config/razorpay.js'

const DOWNLOAD_PRICE = 9900 // ₹99 in paise

const isDuplicatePayment = async (razorpayOrderId) => {
  const existing = await queryOne(
    `SELECT id FROM payments WHERE razorpay_order_id=? AND status='paid'`,
    [razorpayOrderId]
  )
  return !!existing
}

// ─────────────────────────────────────────────────────────────
// POST /api/payments/order
// Creates a Razorpay order to unlock download + hosting for one project (₹99)
// ─────────────────────────────────────────────────────────────
// createOrder — projectId becomes optional/for-reference only; check global has_paid
export const createOrder = async (req, res) => {
  try {
    const { projectId } = req.body // optional now, just for payment history

    const currentUser = await queryOne('SELECT has_paid FROM users WHERE id=?', [req.user.id])
    if (currentUser?.has_paid) {
      return res.status(400).json({ error: 'Download & hosting are already unlocked for your account.' })
    }

    const merchantTransactionId = `zater_unlock_${req.user.id}_${Date.now()}`.slice(0, 40)

    const orderData = await createRazorpayOrder({
      orderId: merchantTransactionId,
      amountPaise: DOWNLOAD_PRICE,
      notes: { userId: String(req.user.id), projectId: projectId || null },
    })

    await query(
      `INSERT INTO payments (id, user_id, project_id, razorpay_order_id, amount, status, type)
       VALUES (?,?,?,?,?,'created','unlock_payment')`,
      [uuidv4(), req.user.id, projectId || null, orderData.id, DOWNLOAD_PRICE]
    )

    res.json({
      razorpayOrderId: orderData.id,
      razorpayKeyId: process.env.RAZORPAY_KEY_ID,
      amount: DOWNLOAD_PRICE,
      currency: 'INR',
    })
  } catch (err) {
    console.error('createOrder:', err)
    res.status(500).json({ error: 'Payment setup failed. Please try again.' })
  }
}

// ─────────────────────────────────────────────────────────────
// POST /api/payments/verify
// Called by frontend after Razorpay Checkout succeeds — signature-based
// ─────────────────────────────────────────────────────────────
export const verifyPayment = async (req, res) => {
  const { razorpay_order_id, razorpay_payment_id, razorpay_signature } = req.body
  try {
    if (await isDuplicatePayment(razorpay_order_id)) {
      return res.json({ status: 'already_processed' })
    }

    const payment = await queryOne(
      'SELECT * FROM payments WHERE razorpay_order_id=? AND user_id=?',
      [razorpay_order_id, req.user.id]
    )
    if (!payment) return res.status(404).json({ error: 'Payment record not found.' })

    const valid = verifyRazorpaySignature({
      orderId: razorpay_order_id,
      paymentId: razorpay_payment_id,
      signature: razorpay_signature,
    })

    if (!valid) {
      await query('UPDATE payments SET status=? WHERE razorpay_order_id=?', ['failed', razorpay_order_id])
      return res.json({ status: 'failed', message: 'Signature verification failed.' })
    }

    // ── Finalize based on payment type ──
 // verifyPayment — unlock_payment branch now sets the GLOBAL flag, not per-project
if (payment.type === 'unlock_payment') {
  await query('UPDATE users SET has_paid = 1 WHERE id=?', [req.user.id])

  await query(
    'UPDATE payments SET razorpay_payment_id=?, status=? WHERE razorpay_order_id=?',
    [razorpay_payment_id, 'paid', razorpay_order_id]
  )

  return res.json({
    status: 'paid',
    message: 'Download and hosting unlocked forever on your account!',
    has_paid: true,
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

      await query(
        'UPDATE payments SET razorpay_payment_id=?, status=? WHERE razorpay_order_id=?',
        [razorpay_payment_id, 'paid', razorpay_order_id]
      )

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
// POST /api/payments/webhook — Razorpay server-to-server callback
// ─────────────────────────────────────────────────────────────
export const razorpayWebhook = async (req, res) => {
  try {
    const signature = req.headers['x-razorpay-signature']
    const valid = verifyWebhookSignature(JSON.stringify(req.body), signature)
    if (!valid) return res.status(400).json({ error: 'Invalid signature' })

    console.log('📩 Razorpay webhook received:', req.body.event)
    res.status(200).json({ received: true })
  } catch (err) {
    console.error('razorpayWebhook:', err)
    res.status(500).json({ error: 'Webhook handling failed' })
  }
}

// ─────────────────────────────────────────────────────────────
// GET /api/payments/history
// ─────────────────────────────────────────────────────────────
export const getHistory = async (req, res) => {
  try {
    const payments = await query(
      `SELECT p.id, p.amount, p.status, p.created_at,
              pr.title AS project_title
       FROM payments p
       LEFT JOIN projects pr ON pr.id = p.project_id
       WHERE p.user_id=? ORDER BY p.created_at DESC`,
      [req.user.id]
    )
    res.json({ payments })
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch history.' })
  }
}