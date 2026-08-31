import { Router } from 'express'
import { getCreditsInfo, createUnlockOrder, createCreditOrder, verifyAndFinalize, razorpayWebhook } from '../controllers/creditsController.js'
import { protect } from '../middleware/auth.js'

const router = Router()

router.get('/', protect, getCreditsInfo)
router.post('/unlock/order', protect, createUnlockOrder)
router.post('/purchase/order', protect, createCreditOrder)
router.post('/verify', protect, verifyAndFinalize)
router.post('/webhook', razorpayWebhook) // no `protect` — Razorpay calls this, not the user

export default router