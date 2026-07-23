import Razorpay from 'razorpay'
import crypto   from 'crypto'
import { v4 as uuidv4 } from 'uuid'
import { query, queryOne } from '../config/db.js'

const razorpay = new Razorpay({
  key_id:     process.env.RAZORPAY_KEY_ID,
  key_secret: process.env.RAZORPAY_KEY_SECRET,
})

// ── Plans (amounts in paise) ─────────────────────────────────
const PLANS = {
  monthly: { amount: 199900,  months: 1,  label: 'Monthly — ₹1,999/month' },
  yearly:  { amount: 1199900, months: 12, label: 'Yearly — ₹11,999/year'  },
  hosting: { amount: 49900,   months: 0,  label: 'Hosting — ₹499/site'    },
}

// ── GET /api/subscriptions/status ────────────────────────────
export const getStatus = async (req, res) => {
  try {
    const user = await queryOne(
      'SELECT id, plan, plan_expires_at FROM users WHERE id=?',
      [req.user.id]
    )

    const rows = await query(
      `SELECT COUNT(*) AS cnt FROM projects
       WHERE user_id=? AND MONTH(created_at)=MONTH(NOW()) AND YEAR(created_at)=YEAR(NOW())`,
      [req.user.id]
    )
    const usedThisMonth = parseInt(rows[0].cnt) || 0

    const isSubscribed =
      user.plan !== 'free' &&
      user.plan_expires_at &&
      new Date(user.plan_expires_at) > new Date()

    const freeUsed  = usedThisMonth >= 1  // used their 1 free site
    const canGenerate = !freeUsed || isSubscribed && usedThisMonth < 10

    res.json({
      plan:         user.plan || 'free',
      expiresAt:    user.plan_expires_at,
      isSubscribed,
      usedThisMonth,
      freeLimit:    1,
      subLimit:     10,
      freeUsed,
      canGenerate,
    })
  } catch (err) {
    console.error('getStatus:', err)
    res.status(500).json({ error: 'Failed to fetch status.' })
  }
}

// ── POST /api/subscriptions/order ────────────────────────────
export const createOrder = async (req, res) => {
  try {
    const { planType, projectId } = req.body

    if (!PLANS[planType]) {
      return res.status(400).json({ error: 'Invalid plan. Use: monthly, yearly, hosting.' })
    }

    if (planType === 'hosting') {
      if (!projectId) return res.status(400).json({ error: 'projectId required for hosting.' })
      const proj = await queryOne(
        'SELECT id, hosting_paid, hosted_domain FROM projects WHERE id=? AND user_id=?',
        [projectId, req.user.id]
      )
      if (!proj)             return res.status(404).json({ error: 'Project not found.' })
      if (proj.hosting_paid) return res.status(400).json({ error: 'Hosting already paid.' })
    }

    const plan  = PLANS[planType]
    const order = await razorpay.orders.create({
      amount:   plan.amount,
      currency: 'INR',
      receipt:  `z_${planType}_${Date.now()}`.slice(0, 40),
      notes:    { planType, userId: String(req.user.id), projectId: projectId || '' },
    })

    await query(
      `INSERT INTO subscription_payments
         (id, user_id, project_id, razorpay_order_id, amount, plan_type, status)
       VALUES (?,?,?,?,?,?,'created')`,
      [uuidv4(), req.user.id, projectId || null, order.id, plan.amount, planType]
    )

    console.log(`💳 ${planType} order: ${order.id}`)
    res.json({
      orderId:  order.id,
      amount:   plan.amount,
      currency: 'INR',
      keyId:    process.env.RAZORPAY_KEY_ID,
      planType,
    })
  } catch (err) {
    console.error('createOrder:', err)
    res.status(500).json({ error: 'Payment setup failed. Please try again.' })
  }
}

// ── POST /api/subscriptions/verify ───────────────────────────
export const verifyPayment = async (req, res) => {
  try {
    const {
      razorpay_order_id, razorpay_payment_id, razorpay_signature,
      planType, projectId,
    } = req.body

    if (!razorpay_order_id || !razorpay_payment_id || !razorpay_signature) {
      return res.status(400).json({ error: 'Missing payment fields.' })
    }

    // Verify Razorpay signature
    const expected = crypto
      .createHmac('sha256', process.env.RAZORPAY_KEY_SECRET)
      .update(`${razorpay_order_id}|${razorpay_payment_id}`)
      .digest('hex')

    if (expected !== razorpay_signature) {
      await query(
        `UPDATE subscription_payments SET status='failed' WHERE razorpay_order_id=?`,
        [razorpay_order_id]
      )
      return res.status(400).json({ error: 'Signature mismatch. Contact support.' })
    }

    // Mark payment as paid
    await query(
      `UPDATE subscription_payments
       SET razorpay_payment_id=?, razorpay_signature=?, status='paid'
       WHERE razorpay_order_id=?`,
      [razorpay_payment_id, razorpay_signature, razorpay_order_id]
    )

    // ── Hosting: activate domain for this project ─────────
    if (planType === 'hosting') {
      const proj = await queryOne('SELECT hosted_domain FROM projects WHERE id=?', [projectId])
      await query(
        `UPDATE projects SET hosting_paid=1, updated_at=NOW() WHERE id=? AND user_id=?`,
        [projectId, req.user.id]
      )
      console.log(`🌐 Hosting activated: ${proj?.hosted_domain}`)
      return res.json({
        success:      true,
        hostedDomain: proj?.hosted_domain,
        message:      `Your site is live at ${proj?.hosted_domain}!`,
      })
    }

    // ── Subscription: set plan + expiry on user ───────────
    const months    = PLANS[planType].months
    const expiresAt = new Date()
    expiresAt.setMonth(expiresAt.getMonth() + months)

    await query(
      `UPDATE users SET plan=?, plan_expires_at=? WHERE id=?`,
      [planType, expiresAt, req.user.id]
    )

    console.log(`✅ ${planType} activated for user ${req.user.id}, expires ${expiresAt}`)
    res.json({
      success:   true,
      planType,
      expiresAt,
      message:   `${planType === 'monthly' ? 'Monthly' : 'Yearly'} plan activated! Generate up to 10 websites/month.`,
    })
  } catch (err) {
    console.error('verifyPayment:', err)
    res.status(500).json({ error: 'Verification failed. Contact support.' })
  }
}

// ── GET /api/subscriptions/history ───────────────────────────
export const getHistory = async (req, res) => {
  try {
    const payments = await query(
      `SELECT sp.id, sp.plan_type, sp.amount, sp.status, sp.created_at,
              p.title AS project_title, p.hosted_domain
       FROM subscription_payments sp
       LEFT JOIN projects p ON p.id = sp.project_id
       WHERE sp.user_id=? ORDER BY sp.created_at DESC`,
      [req.user.id]
    )
    res.json({ payments })
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch history.' })
  }
}
