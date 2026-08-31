import { v4 as uuidv4 } from 'uuid'
import { query, queryOne } from '../config/db.js'
import { createRazorpayOrder, verifyRazorpaySignature, verifyWebhookSignature } from '../config/razorpay.js'

const DOWNLOAD_PRICE = 49900 // ₹499 in paise

// POST /api/payments/order
// Creates Cashfree payment for ₹499 download
export const createOrder = async (req, res) => {
  try {
    const { projectId } = req.body
    if (!projectId) return res.status(400).json({ error: 'projectId is required.' })

    const project = await queryOne(
      'SELECT * FROM projects WHERE id=? AND user_id=?',
      [projectId, req.user.id]
    )
    if (!project)              return res.status(404).json({ error: 'Project not found.' })
    if (project.status !== 'ready') return res.status(400).json({ error: 'Website is still generating.' })
    if (project.download_paid) return res.status(400).json({ error: 'Download already unlocked.' })

    const merchantTransactionId = `zater_dl_${projectId.slice(0, 8)}_${Date.now()}`.slice(0, 40)

    // inside createOrder — replace the createCashfreeOrder call + response
const orderData = await createRazorpayOrder({
  orderId: merchantTransactionId,
  amountPaise: DOWNLOAD_PRICE,
  notes: { userId: String(req.user.id), projectId },
})

await query(
  `INSERT INTO payments (id, user_id, project_id, razorpay_order_id, amount, status)
   VALUES (?,?,?,?,?,'created')`,
  [uuidv4(), req.user.id, projectId, orderData.id, DOWNLOAD_PRICE]
)

console.log(`💳 Razorpay order: ${orderData.id} for project ${projectId}`)
res.json({
  razorpayOrderId: orderData.id,
  razorpayKeyId: process.env.RAZORPAY_KEY_ID,   // frontend needs this to open Checkout
  amount: DOWNLOAD_PRICE,
  currency: 'INR',
})
  } catch (err) {
    console.error('createOrder:', err)
    res.status(500).json({ error: 'Payment setup failed. Please try again.' })
  }
}

// POST /api/payments/verify
// Called by your frontend after Cashfree redirects back
// verifyPayment is now signature-based, not a status poll — replace the whole function body
// checkPaymentStatus becomes verifyAndFinalize — signature check replaces checkCashfreeStatus poll
// POST /api/payments/verify
// Called by frontend after Razorpay Checkout succeeds — signature-based, not a status poll
// ─────────────────────────────────────────────────────────────
// POST /api/credits/verify
// Called by frontend after Razorpay Checkout succeeds
// ─────────────────────────────────────────────────────────────
export const verifyPayment = async (req, res) => {
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

    // ── Finalize based on payment type ──
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
// POST /api/credits/webhook — Razorpay server-to-server callback
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

// GET /api/payments/history
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