import { queryOne, query } from '../config/db.js'

// PLANS:
// free    → 1 site/month, hosting ₹499/site extra
// basic   → ₹499/mo  → 1 site/month, hosting included
// growth  → ₹1,999/mo → 10 sites/month, hosting included
// yearly  → ₹11,999/yr → 10 sites/month, hosting included

export const checkSubscription = async (req, res, next) => {
  try {
    const user = await queryOne(
      'SELECT id, plan, plan_expires_at FROM users WHERE id=?',
      [req.user.id]
    )

    const rows = await query(
      `SELECT COUNT(*) AS cnt FROM projects
       WHERE user_id=?
         AND MONTH(created_at)=MONTH(NOW())
         AND YEAR(created_at)=YEAR(NOW())`,
      [req.user.id]
    )
    const usedThisMonth = parseInt(rows[0].cnt) || 0

    const planActive =
      user.plan !== 'free' &&
      user.plan_expires_at &&
      new Date(user.plan_expires_at) > new Date()

    const plan = planActive ? user.plan : 'free'

    // Limits per plan
    const LIMITS = { free: 1, basic: 1, growth: 10, yearly: 10 }
    const limit  = LIMITS[plan] || 1

    if (usedThisMonth >= limit) {
      if (plan === 'free') {
        return res.status(403).json({
          error: 'You have used your 1 free website this month.',
          code:  'FREE_LIMIT_REACHED',
          used:  usedThisMonth,
        })
      }
      if (plan === 'basic') {
        return res.status(403).json({
          error: 'Your Basic plan allows 1 website/month. Upgrade for more.',
          code:  'PLAN_LIMIT_REACHED',
          used:  usedThisMonth,
        })
      }
      return res.status(403).json({
        error: `Monthly limit reached (${usedThisMonth}/10). Resets on the 1st.`,
        code:  'PLAN_LIMIT_REACHED',
        used:  usedThisMonth,
      })
    }

    req.userPlan      = plan
    req.usedThisMonth = usedThisMonth
    req.hostingFree   = planActive // paid plans include hosting
    next()
  } catch (err) {
    console.error('checkSubscription:', err)
    res.status(500).json({ error: 'Subscription check failed.' })
  }
}
