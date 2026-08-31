import { Router } from 'express'
import {
  signup, login, getMe, getCredits,
  forgotPassword, resetPassword, validateResetToken,
  googleAuth, changePassword,
  sendEmailOTP, verifyEmailOTP
} from '../controllers/authController.js'
import { protect } from '../middleware/auth.js'

const router = Router()

router.post('/signup',               signup)
router.post('/login',                login)
router.post('/google',               googleAuth)
router.post('/send-otp',             sendEmailOTP)
router.post('/verify-otp',           verifyEmailOTP)
router.get('/me',                    protect, getMe)
router.get('/credits',               protect, getCredits)
router.post('/forgot-password',      forgotPassword)
router.post('/reset-password',       resetPassword)
router.post('/validate-reset-token', validateResetToken)
router.post('/change-password',      protect, changePassword)

export default router