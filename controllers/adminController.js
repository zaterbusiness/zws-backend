import { query, queryOne } from '../config/db.js'
import bcrypt from 'bcryptjs'
import jwt    from 'jsonwebtoken'

// ── POST /api/admin/login ─────────────────────────────────────
export const adminLogin = async (req, res) => {
  try {
    const { email, password } = req.body
    if (!email || !password) return res.status(400).json({ error: 'Email and password required.' })

    const user = await queryOne('SELECT * FROM users WHERE email=?', [email.toLowerCase()])
    if (!user)                 return res.status(401).json({ error: 'Invalid email or password.' })
    if (user.role !== 'admin') return res.status(403).json({ error: 'Admin access only.' })

    const valid = await bcrypt.compare(password, user.password)
    if (!valid) return res.status(401).json({ error: 'Invalid email or password.' })

    // ── Sign token with NO expiry — unlimited session ─────────
    const token = jwt.sign(
      { id: user.id, email: user.email, name: user.name, role: 'admin' },
      process.env.JWT_SECRET
      // no expiresIn = token never expires
    )

    console.log(`🔐 Admin login: ${email}`)
    res.json({
      token,
      admin: { id: user.id, name: user.name, email: user.email, avatar: user.avatar }
    })
  } catch (err) {
    console.error('adminLogin:', err)
    res.status(500).json({ error: 'Login failed.' })
  }
}

// ── GET /api/admin/templates ──────────────────────────────────
export const getTemplateDeployments = async (req, res) => {
  try {
    const { search = '', page = 1, limit = 20 } = req.query
    const offset = (Number(page) - 1) * Number(limit)

    const cols   = await query('SHOW COLUMNS FROM projects')
    const pNames = cols.map(c => c.Field)

    const hostedSubSql  = pNames.includes('hosted_subdomain') ? "COALESCE(p.hosted_subdomain,'')" : "''"
    const hostedUrlSql  = pNames.includes('hosted_url')       ? "COALESCE(p.hosted_url,'')"       : "''"
    const templateIdSql = pNames.includes('template_id')      ? "COALESCE(p.template_id,'')"      : "''"
    const templateNmSql = pNames.includes('template_name')    ? "COALESCE(p.template_name,'')"    : "''"
    const hPaidSql      = pNames.includes('hosting_paid')     ? 'COALESCE(p.hosting_paid,0)'      : '0'
    const isTemplateSql = pNames.includes('is_template')      ? 'COALESCE(p.is_template,0)'       : '0'

    const hasHostedSub  = pNames.includes('hosted_subdomain')
    const hasHostedUrl  = pNames.includes('hosted_url')
    const hasIsTemplate = pNames.includes('is_template')

    const deployConditions = []
    if (hasHostedSub)  deployConditions.push("p.hosted_subdomain IS NOT NULL AND p.hosted_subdomain != ''")
    if (hasHostedUrl)  deployConditions.push("p.hosted_url IS NOT NULL AND p.hosted_url != ''")
    if (hasIsTemplate) deployConditions.push("p.is_template = 1")
    if (deployConditions.length === 0) deployConditions.push('COALESCE(p.hosting_paid,0) = 1')

    const deployWhere = `(${deployConditions.join(' OR ')})`

    const searchCondition = search
      ? `AND (p.title LIKE ? OR u.name LIKE ? OR u.email LIKE ?)`
      : ''
    const searchParams = search ? [`%${search}%`, `%${search}%`, `%${search}%`] : []

    const deployments = await query(`
      SELECT
        p.id,
        p.title,
        p.status,
        p.created_at,
        ${hostedSubSql}  AS hosted_subdomain,
        ${hostedUrlSql}  AS hosted_url,
        ${templateIdSql} AS template_id,
        ${templateNmSql} AS template_name,
        ${hPaidSql}      AS hosting_paid,
        ${isTemplateSql} AS is_template,
        u.id   AS user_id,
        u.name AS user_name,
        u.email AS user_email,
        COALESCE(u.avatar,'') AS user_avatar
      FROM projects p
      JOIN users u ON u.id = p.user_id
      WHERE ${deployWhere} ${searchCondition}
      ORDER BY p.created_at DESC
      LIMIT ${Number(limit)} OFFSET ${offset}
    `, searchParams)

    const [{ total }] = await query(`
      SELECT COUNT(*) AS total
      FROM projects p
      JOIN users u ON u.id = p.user_id
      WHERE ${deployWhere} ${searchCondition}
    `, searchParams)

    const [{ totalDeployments }] = await query(`
      SELECT COUNT(*) AS totalDeployments FROM projects p WHERE ${deployWhere}
    `)
    const [{ totalDeployedUsers }] = await query(`
      SELECT COUNT(DISTINCT p.user_id) AS totalDeployedUsers FROM projects p WHERE ${deployWhere}
    `)

    res.json({
      deployments,
      total: Number(total),
      totalDeployments: Number(totalDeployments),
      totalDeployedUsers: Number(totalDeployedUsers),
      page: Number(page),
      limit: Number(limit),
    })
  } catch (err) {
    console.error('getTemplateDeployments:', err)
    res.status(500).json({ error: 'Failed to fetch template deployments.' })
  }
}

// ── GET /api/admin/dashboard ──────────────────────────────────
export const getDashboard = async (req, res) => {
  try {
    const [[{ totalUsers }], [{ totalProjects }], [{ totalApps }], [{ totalRevenue }],
           [{ todayUsers }], [{ todayProjects }], [{ todayRevenue }], [{ activeToday }]] =
      await Promise.all([
        query('SELECT COUNT(*) AS totalUsers FROM users'),
        query('SELECT COUNT(*) AS totalProjects FROM projects'),
        query('SELECT COUNT(*) AS totalApps FROM apps'),
        query(`SELECT COALESCE(SUM(amount),0) AS totalRevenue FROM payments WHERE status='paid'`),
        query(`SELECT COUNT(*) AS todayUsers FROM users WHERE DATE(created_at)=CURDATE()`),
        query(`SELECT COUNT(*) AS todayProjects FROM projects WHERE DATE(created_at)=CURDATE()`),
        query(`SELECT COALESCE(SUM(amount),0) AS todayRevenue FROM payments WHERE status='paid' AND DATE(created_at)=CURDATE()`),
        query(`SELECT COUNT(DISTINCT user_id) AS activeToday FROM projects WHERE DATE(created_at)=CURDATE()`),
      ])

    const revenueChart = await query(`
      SELECT DATE(created_at) AS date, COALESCE(SUM(amount),0) AS revenue, COUNT(*) AS count
      FROM payments WHERE status='paid' AND created_at >= DATE_SUB(NOW(), INTERVAL 7 DAY)
      GROUP BY DATE(created_at) ORDER BY date ASC`)

    const projectsChart = await query(`
      SELECT DATE(created_at) AS date, COUNT(*) AS count
      FROM projects WHERE created_at >= DATE_SUB(NOW(), INTERVAL 7 DAY)
      GROUP BY DATE(created_at) ORDER BY date ASC`)

    const topUsers = await query(`
      SELECT u.id, u.name, u.email, u.avatar,
        (SELECT COUNT(*) FROM projects p WHERE p.user_id = u.id) AS projects,
        (SELECT COUNT(*) FROM apps a WHERE a.user_id = u.id) AS apps,
        COALESCE((
          SELECT SUM(pay.amount) FROM payments pay
          WHERE pay.user_id = u.id AND pay.status = 'paid'
        ), 0) AS spent
      FROM users u
      ORDER BY projects DESC LIMIT 5`)

    const recentActivity = await query(`
      SELECT 'project' AS type, p.title, p.status, p.created_at,
             u.name AS user_name, u.email AS user_email
      FROM projects p JOIN users u ON u.id=p.user_id
      UNION ALL
      SELECT 'app' AS type, a.title, a.status, a.created_at,
             u.name AS user_name, u.email AS user_email
      FROM apps a JOIN users u ON u.id=a.user_id
      ORDER BY created_at DESC LIMIT 15`)

    res.json({
      stats: {
        totalUsers, todayUsers, totalProjects, todayProjects, totalApps,
        totalRevenue: Number(totalRevenue), todayRevenue: Number(todayRevenue), activeToday,
      },
      revenueChart, projectsChart, topUsers, recentActivity,
    })
  } catch (err) {
    console.error('getDashboard:', err)
    res.status(500).json({ error: 'Failed to fetch dashboard.' })
  }
}

// ── GET /api/admin/users ──────────────────────────────────────
export const getUsers = async (req, res) => {
  try {
    const { search = '', page = 1, limit = 20 } = req.query
    const offset  = (Number(page) - 1) * Number(limit)
    const where   = search ? 'WHERE u.name LIKE ? OR u.email LIKE ?' : ''
    const params  = search ? [`%${search}%`, `%${search}%`] : []

    const cols     = await query('SHOW COLUMNS FROM users')
    const colNames = cols.map(c => c.Field)
    const phoneSql  = colNames.includes('phone')  ? "COALESCE(u.phone,'')"          : "''"
    const statusSql = colNames.includes('status') ? "COALESCE(u.status,'active')"   : "'active'"
    const planSql   = colNames.includes('plan')   ? "COALESCE(u.plan,'free')"       : "'free'"

    const users = await query(`
      SELECT u.id, u.name, u.email, COALESCE(u.avatar,'') AS avatar,
        COALESCE(u.role,'user') AS role,
        ${planSql}   AS plan,
        ${statusSql} AS status,
        ${phoneSql}  AS phone,
        u.created_at,
        COUNT(DISTINCT p.id)  AS total_projects,
        COUNT(DISTINCT a.id)  AS total_apps,
        COALESCE((
          SELECT COUNT(*) FROM payments hp2 WHERE hp2.user_id = u.id
        ), 0) AS total_payments,
        COALESCE((
          SELECT SUM(hp2.amount) FROM payments hp2
          WHERE hp2.user_id = u.id AND hp2.status = 'paid'
        ), 0) AS total_spent,
        MAX(p.created_at) AS last_active
      FROM users u
      LEFT JOIN projects p  ON p.user_id = u.id
      LEFT JOIN apps a      ON a.user_id = u.id
      ${where}
      GROUP BY u.id, u.name, u.email, u.avatar, u.role
      ORDER BY u.created_at DESC
      LIMIT ${Number(limit)} OFFSET ${offset}
    `, params)

    const [{ total }] = await query(`SELECT COUNT(*) AS total FROM users u ${where}`, params)
    res.json({ users, total: Number(total), page: Number(page), limit: Number(limit) })
  } catch (err) {
    console.error('getUsers:', err)
    res.status(500).json({ error: 'Failed to fetch users.' })
  }
}

// ── GET /api/admin/users/:id ──────────────────────────────────
export const getUserDetail = async (req, res) => {
  try {
    const user = await queryOne(
      `SELECT id, name, email, COALESCE(avatar,'') AS avatar,
       COALESCE(role,'user') AS role, created_at FROM users WHERE id=?`,
      [req.params.id]
    )
    if (!user) return res.status(404).json({ error: 'User not found.' })
    res.json({ user })
  } catch (err) { res.status(500).json({ error: 'Failed.' }) }
}

// ── GET /api/admin/users/:id/full ────────────────────────────
// (single, fixed definition — dynamically checks payments columns)
// ── GET /api/admin/users/:id/full ────────────────────────────
export const getFullUserDetail = async (req, res) => {
  try {
    const ucols    = await query('SHOW COLUMNS FROM users')
    const uNames   = ucols.map(c => c.Field)
    const phoneSql  = uNames.includes('phone')  ? "COALESCE(phone,'')"         : "''"
    const statusSql = uNames.includes('status') ? "COALESCE(status,'active')"  : "'active'"
    const planSql   = uNames.includes('plan')   ? "COALESCE(plan,'free')"      : "'free'"

    const pcols    = await query('SHOW COLUMNS FROM projects')
    const pNames   = pcols.map(c => c.Field)
    const hPaidSql = pNames.includes('hosting_paid')     ? 'COALESCE(hosting_paid,0)'      : '0'
    const hSubSql  = pNames.includes('hosted_subdomain') ? "COALESCE(hosted_subdomain,'')" : "''"

    const payCols  = await query('SHOW COLUMNS FROM payments')
    const payNames = payCols.map(c => c.Field)
    const hasProjectId = payNames.includes('project_id')
    const rzpSql = payNames.includes('razorpay_payment_id') ? "COALESCE(p.razorpay_payment_id,'')" : "''"

    const user = await queryOne(`
      SELECT id, name, email, COALESCE(avatar,'') AS avatar,
        COALESCE(role,'user') AS role,
        ${planSql}   AS plan,
        ${statusSql} AS status,
        ${phoneSql}  AS phone,
        created_at
      FROM users WHERE id=?
    `, [req.params.id])
    if (!user) return res.status(404).json({ error: 'User not found.' })

    // ── Each block below is isolated so one bad table/column
    //    can't 500 the whole endpoint — and we log exactly which one failed.
    let projects = []
    try {
      projects = await query(`
        SELECT id, title, COALESCE(prompt,'') AS prompt, status,
               COALESCE(download_paid,0) AS download_paid,
               ${hPaidSql} AS hosting_paid, ${hSubSql} AS hosted_subdomain,
               created_at
        FROM projects WHERE user_id=? ORDER BY created_at DESC
      `, [req.params.id])
    } catch (e) { console.error('getFullUserDetail [projects]:', e.sqlMessage || e.message) }

    let apps = []
    try {
      apps = await query(`
        SELECT id, title, COALESCE(prompt,'') AS prompt, status,
               COALESCE(download_paid,0) AS download_paid, created_at
        FROM apps WHERE user_id=? ORDER BY created_at DESC
      `, [req.params.id])
    } catch (e) { console.error('getFullUserDetail [apps]:', e.sqlMessage || e.message) }

    let payments = []
    try {
      payments = await query(`
        SELECT p.id, p.amount, p.status,
               ${rzpSql} AS razorpay_payment_id,
               p.created_at
               ${hasProjectId ? ", COALESCE(pr.title,'') AS project_title" : ", '' AS project_title"}
        FROM payments p
        ${hasProjectId ? 'LEFT JOIN projects pr ON pr.id=p.project_id' : ''}
        WHERE p.user_id=? ORDER BY p.created_at DESC
      `, [req.params.id])
    } catch (e) { console.error('getFullUserDetail [payments]:', e.sqlMessage || e.message) }

    let hostingPayments = []
    try {
      hostingPayments = await query(`
        SELECT hp.id, hp.amount, hp.status,
               COALESCE(hp.subdomain,'') AS subdomain, hp.created_at,
               COALESCE(pr.title,'') AS project_title
        FROM hosting_payments hp
        LEFT JOIN projects pr ON pr.id=hp.project_id
        WHERE hp.user_id=? ORDER BY hp.created_at DESC
      `, [req.params.id])
    } catch (e) { console.error('getFullUserDetail [hostingPayments]:', e.sqlMessage || e.message) }

    const totalSpent = payments
      .filter(p => p.status === 'paid')
      .reduce((s, p) => s + Number(p.amount), 0)

    res.json({ user, projects, apps, payments, hostingPayments, totalSpent })
  } catch (err) {
    console.error('getFullUserDetail:', err.sqlMessage || err.message, err.stack)
    res.status(500).json({ error: err.sqlMessage || err.message || 'Failed to fetch user detail.' })
  }
}

// ── PUT /api/admin/users/:id/role ─────────────────────────────
export const updateUserRole = async (req, res) => {
  try {
    const { role } = req.body
    if (!['user','admin'].includes(role)) return res.status(400).json({ error: 'Invalid role.' })
    await query('UPDATE users SET role=? WHERE id=?', [role, req.params.id])
    res.json({ message: `Role updated to ${role}.` })
  } catch (err) { res.status(500).json({ error: 'Failed.' }) }
}

// ── PUT /api/admin/users/:id/status ──────────────────────────
export const updateUserStatus = async (req, res) => {
  try {
    const { status } = req.body
    if (!['active','paused'].includes(status)) return res.status(400).json({ error: 'Invalid status.' })
    if (String(req.params.id) === String(req.user.id)) return res.status(400).json({ error: 'Cannot change your own status.' })
    await query('UPDATE users SET status=? WHERE id=?', [status, req.params.id])
    res.json({ message: `Account ${status === 'paused' ? 'paused' : 'reactivated'}.` })
  } catch (err) { res.status(500).json({ error: 'Failed.' }) }
}

// ── DELETE /api/admin/users/:id ───────────────────────────────
export const deleteUser = async (req, res) => {
  try {
    if (String(req.params.id) === String(req.user.id)) return res.status(400).json({ error: 'Cannot delete your own account.' })
    await query('DELETE FROM users WHERE id=?', [req.params.id])
    res.json({ message: 'User deleted.' })
  } catch (err) { res.status(500).json({ error: 'Failed.' }) }
}

// ── GET /api/admin/projects ───────────────────────────────────
export const getProjects = async (req, res) => {
  try {
    const { search = '', status = '', page = 1, limit = 20 } = req.query
    const offset = (Number(page) - 1) * Number(limit)

    const pCols  = await query('SHOW COLUMNS FROM projects')
    const pNames = pCols.map(c => c.Field)
    const hPaidSql = pNames.includes('hosting_paid')     ? 'COALESCE(hosting_paid,0)'      : '0'
    const hSubSql  = pNames.includes('hosted_subdomain') ? "COALESCE(hosted_subdomain,'')" : "''"

    const wConditions = []; const wParams = []
    if (search) { wConditions.push('(p.title LIKE ? OR u.email LIKE ?)'); wParams.push(`%${search}%`, `%${search}%`) }
    if (status) { wConditions.push('p.status=?'); wParams.push(status) }
    const wWhere = wConditions.length ? `WHERE ${wConditions.join(' AND ')}` : ''

    const aConditions = []; const aParams = []
    if (search) { aConditions.push('(a.title LIKE ? OR u.email LIKE ?)'); aParams.push(`%${search}%`, `%${search}%`) }
    if (status) { aConditions.push('a.status=?'); aParams.push(status) }
    const aWhere = aConditions.length ? `WHERE ${aConditions.join(' AND ')}` : ''

    const combined = await query(`
      (
        SELECT p.id, p.title, p.prompt, p.status,
               COALESCE(p.download_paid,0) AS download_paid,
               ${hPaidSql} AS hosting_paid,
               ${hSubSql}  AS hosted_subdomain,
               p.created_at, 'website' AS type,
               u.name AS user_name, u.email AS user_email, COALESCE(u.avatar,'') AS user_avatar
        FROM projects p JOIN users u ON u.id=p.user_id
        ${wWhere}
      )
      UNION ALL
      (
        SELECT a.id, a.title, a.prompt, a.status,
               COALESCE(a.download_paid,0) AS download_paid,
               0 AS hosting_paid,
               '' AS hosted_subdomain,
               a.created_at, 'app' AS type,
               u.name AS user_name, u.email AS user_email, COALESCE(u.avatar,'') AS user_avatar
        FROM apps a JOIN users u ON u.id=a.user_id
        ${aWhere}
      )
      ORDER BY created_at DESC
      LIMIT ${Number(limit)} OFFSET ${offset}
    `, [...wParams, ...aParams])

    const [{ total }] = await query(`
      SELECT (
        (SELECT COUNT(*) FROM projects p JOIN users u ON u.id=p.user_id ${wWhere})
        +
        (SELECT COUNT(*) FROM apps a JOIN users u ON u.id=a.user_id ${aWhere})
      ) AS total
    `, [...wParams, ...aParams])

    res.json({ projects: combined, total: Number(total) })
  } catch (err) {
    console.error('getProjects:', err)
    res.status(500).json({ error: 'Failed to fetch projects.' })
  }
}

// ── GET /api/admin/payments ───────────────────────────────────
export const getPayments = async (req, res) => {
  try {
    const page   = Number(req.query.page  || 1)
    const limit  = Number(req.query.limit || 20)
    const offset = (page - 1) * limit

    const pCols   = await query('SHOW COLUMNS FROM payments')
    const pNames  = pCols.map(c => c.Field)
    const rzpSql      = pNames.includes('razorpay_payment_id') ? "COALESCE(p.razorpay_payment_id,'')" : "''"
    const projectIdSql = pNames.includes('project_id')

    const payments = await query(`
      SELECT p.id, p.amount, p.status, p.created_at,
             ${rzpSql} AS razorpay_payment_id,
             u.name AS user_name, u.email AS user_email
             ${projectIdSql ? ", COALESCE(pr.title,'') AS project_title" : ", '' AS project_title"}
      FROM payments p
      JOIN users u ON u.id=p.user_id
      ${projectIdSql ? 'LEFT JOIN projects pr ON pr.id=p.project_id' : ''}
      ORDER BY p.created_at DESC
      LIMIT ${limit} OFFSET ${offset}
    `)

    const [{ total }]   = await query('SELECT COUNT(*) AS total FROM payments')
    const [{ revenue }] = await query(`SELECT COALESCE(SUM(amount),0) AS revenue FROM payments WHERE status='paid'`)
    res.json({ payments, total: Number(total), revenue: Number(revenue) })
  } catch (err) {
    console.error('getPayments:', err)
    res.status(500).json({ error: err.message })
  }
}

// ── GET /api/admin/stats/realtime ────────────────────────────
export const getRealtimeStats = async (req, res) => {
  try {
    const [[{ onlineNow }]] = await Promise.all([
      query(`SELECT COUNT(DISTINCT user_id) AS onlineNow FROM projects WHERE created_at >= DATE_SUB(NOW(), INTERVAL 1 HOUR)`)
    ])
    const last5Projects = await query(`
      SELECT p.title, p.status, p.created_at, u.name AS user_name
      FROM projects p JOIN users u ON u.id=p.user_id
      ORDER BY p.created_at DESC LIMIT 5`)
    const last5Payments = await query(`
      SELECT p.amount, p.status, p.created_at, u.name AS user_name
      FROM payments p JOIN users u ON u.id=p.user_id
      WHERE p.status='paid' ORDER BY p.created_at DESC LIMIT 5`)
    res.json({ onlineNow, last5Projects, last5Payments })
  } catch (err) { res.status(500).json({ error: 'Failed.' }) }
}