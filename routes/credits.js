import { Router } from 'express'
import {
  getCreditsInfo,
  createUnlockOrder,
  createCreditOrder,
  checkPaymentStatus,
  phonepeWebhook,
} from '../controllers/creditsController.js'
import { protect } from '../middleware/auth.js'

const router = Router()

router.get('/', protect, getCreditsInfo)
router.post('/unlock/order', protect, createUnlockOrder)
router.post('/purchase/order', protect, createCreditOrder)
router.get('/status/:merchantTransactionId', protect, checkPaymentStatus)
router.post('/webhook', phonepeWebhook) // no `protect` — PhonePe calls this, not the user

export default router