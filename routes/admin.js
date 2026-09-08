import { Router } from 'express'
import {
  getDashboard, getUsers, getUserDetail, getFullUserDetail,
  updateUserRole, updateUserStatus, deleteUser,
  getProjects, getPayments, deletePayment, getRealtimeStats, adminLogin,
  getTemplateDeployments, getAppsAdmin, pushAppToGithubAdmin
} from '../controllers/adminController.js'
import { getCreditUsers, adjustCredits, setCredits } from '../controllers/adminCreditsController.js'
import { adminProtect } from '../middleware/adminAuth.js'
import { query, queryOne } from '../config/db.js'   // ← ADD THIS

const router = Router()

router.post('/login', adminLogin)

// Platform status routes (use adminProtect, not adminMiddleware)
router.get('/platform-status', adminProtect, async (req, res) => {
  try {
    const row = await queryOne(
      "SELECT `value` FROM payment_settings WHERE `key` = 'platform_enabled'",
      []
    )
    res.json({ enabled: row?.value === '1' })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

router.put('/platform-status', adminProtect, async (req, res) => {
  try {
    const { enabled } = req.body
    const val = enabled ? '1' : '0'
    await query(
      "UPDATE payment_settings SET `value` = ? WHERE `key` = 'platform_enabled'",
      [val]
    )
    res.json({ success: true, enabled })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// All other routes

router.use(adminProtect)
router.get('/dashboard',          getDashboard)
router.get('/stats/realtime',     getRealtimeStats)
router.get('/users',              getUsers)
router.get('/users/:id',          getUserDetail)
router.get('/users/:id/full',     getFullUserDetail)
router.put('/users/:id/role',     updateUserRole)
router.put('/users/:id/status',   updateUserStatus)
router.delete('/users/:id',       deleteUser)
router.get('/projects',           getProjects)
router.get('/payments',           getPayments)
router.get('/templates',          getTemplateDeployments)
router.get('/credits/users',      getCreditUsers)
router.post('/credits/adjust',    adjustCredits)
router.post('/credits/set',       setCredits)
router.get('/apps',                    getAppsAdmin)
router.post('/apps/:id/github-push',   pushAppToGithubAdmin)
router.delete('/payments/:id',    deletePayment)
export default router