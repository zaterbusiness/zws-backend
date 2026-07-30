import { v4 as uuidv4 } from 'uuid'
import { query, queryOne } from '../config/db.js'
import { createCashfreeOrder, checkCashfreeStatus } from '../config/cashfree.js'

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

    const orderData = await createCashfreeOrder({
      orderId: merchantTransactionId,
      amountPaise: DOWNLOAD_PRICE,
      customerId: String(req.user.id),
      customerPhone: req.user.phone,
      returnUrl: `${process.env.FRONTEND_URL}/payment/status?txnId=${merchantTransactionId}&projectId=${projectId}`,
    })

    // Reusing existing columns: razorpay_order_id stores the Cashfree order id
    await query(
      `INSERT INTO payments (id, user_id, project_id, razorpay_order_id, amount, status)
       VALUES (?,?,?,?,?,'created')`,
      [uuidv4(), req.user.id, projectId, merchantTransactionId, DOWNLOAD_PRICE]
    )

    console.log(`💳 Cashfree order: ${merchantTransactionId} for project ${projectId}`)
    res.json({
      merchantTransactionId,
      paymentSessionId: orderData.payment_session_id,
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
export const verifyPayment = async (req, res) => {
  try {
    const { merchantTransactionId, projectId } = req.body
    if (!merchantTransactionId) return res.status(400).json({ error: 'Missing transaction id.' })

    const statusRes = await checkCashfreeStatus(merchantTransactionId)

    if (statusRes?.order_status !== 'PAID') {
      await query(`UPDATE payments SET status='failed' WHERE razorpay_order_id=?`, [merchantTransactionId])
      return res.status(400).json({ error: 'Payment not successful.', status: statusRes?.order_status })
    }

    const providerTxnId = statusRes?.cf_order_id || merchantTransactionId

    await query(
      `UPDATE payments SET razorpay_payment_id=?, status='paid'
       WHERE razorpay_order_id=?`,
      [providerTxnId, merchantTransactionId]
    )

    await query(
      `UPDATE projects SET download_paid=1, updated_at=NOW() WHERE id=? AND user_id=?`,
      [projectId, req.user.id]
    )

    console.log(`✅ Download unlocked: ${projectId}`)
    res.json({ success: true, message: 'Payment successful! You can now download your website.' })
  } catch (err) {
    console.error('verifyPayment:', err)
    res.status(500).json({ error: 'Verification failed. Contact support.' })
  }
}

// POST /api/payments/callback
// Cashfree server-to-server callback (optional but recommended)
export const paymentCallback = async (req, res) => {
  try {
    console.log('Cashfree callback received:', req.body)
    res.status(200).json({ received: true })
  } catch (err) {
    console.error('paymentCallback:', err)
    res.status(500).json({ error: 'Callback handling failed' })
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