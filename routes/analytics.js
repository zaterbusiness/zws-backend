import { Router } from 'express'
import { trackView, getProjectAnalytics } from '../controllers/analyticsController.js'
import { protect } from '../middleware/auth.js'

const router = Router()
router.post('/track/:projectId', trackView)
router.get('/:projectId', protect, getProjectAnalytics)
export default router