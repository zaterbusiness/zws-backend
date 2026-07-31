import { Router } from 'express'
import {
  signup, login, getMe, getCredits,
  forgotPassword, resetPassword, validateResetToken,
  googleAuth, changePassword
} from '../controllers/authController.js'
import { protect } from '../middleware/auth.js'

const router = Router()

router.post('/signup',               signup)
router.post('/login',                login)
router.post('/google',               googleAuth)
router.get('/me',                    protect, getMe)
router.get('/credits',               protect, getCredits)        // ← NEW: quick credit balance
router.post('/forgot-password',      forgotPassword)
router.post('/reset-password',       resetPassword)
router.post('/validate-reset-token', validateResetToken)
router.post('/change-password',      protect, changePassword)   // ← NEW

export default router
