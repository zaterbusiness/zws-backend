import Razorpay from 'razorpay'
import crypto   from 'crypto'
import { v4 as uuidv4 } from 'uuid'
import { query, queryOne } from '../config/db.js'

const razorpay = new Razorpay({
  key_id:     process.env.RAZORPAY_KEY_ID,
  key_secret: process.env.RAZORPAY_KEY_SECRET,
})

const DOWNLOAD_PRICE = 49900 // ₹499 in paise

// POST /api/payments/order
// Creates Razorpay order for ₹499 download
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

    const order = await razorpay.orders.create({
      amount:   DOWNLOAD_PRICE,
      currency: 'INR',
      receipt:  `zater_dl_${projectId.slice(0,8)}_${Date.now()}`.slice(0, 40),
      notes:    { projectId, userId: String(req.user.id) },
    })

    await query(
      `INSERT INTO payments (id, user_id, project_id, razorpay_order_id, amount, status)
       VALUES (?,?,?,?,?,'created')`,
      [uuidv4(), req.user.id, projectId, order.id, DOWNLOAD_PRICE]
    )

    console.log(`💳 Download order: ${order.id} for project ${projectId}`)
    res.json({
      orderId:  order.id,
      amount:   DOWNLOAD_PRICE,
      currency: 'INR',
      keyId:    process.env.RAZORPAY_KEY_ID,
    })
  } catch (err) {
    console.error('createOrder:', err)
    res.status(500).json({ error: 'Payment setup failed. Please try again.' })
  }
}

// POST /api/payments/verify
export const verifyPayment = async (req, res) => {
  try {
    const { razorpay_order_id, razorpay_payment_id, razorpay_signature, projectId } = req.body

    if (!razorpay_order_id || !razorpay_payment_id || !razorpay_signature)
      return res.status(400).json({ error: 'Missing payment fields.' })

    // Verify Razorpay HMAC signature
    const expected = crypto
      .createHmac('sha256', process.env.RAZORPAY_KEY_SECRET)
      .update(`${razorpay_order_id}|${razorpay_payment_id}`)
      .digest('hex')

    if (expected !== razorpay_signature) {
      await query(`UPDATE payments SET status='failed' WHERE razorpay_order_id=?`, [razorpay_order_id])
      return res.status(400).json({ error: 'Payment signature invalid. Contact support.' })
    }

    // Mark payment paid
    await query(
      `UPDATE payments SET razorpay_payment_id=?, razorpay_signature=?, status='paid'
       WHERE razorpay_order_id=?`,
      [razorpay_payment_id, razorpay_signature, razorpay_order_id]
    )

    // Unlock download on project
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
