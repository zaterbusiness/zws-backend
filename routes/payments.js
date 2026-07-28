import { Router } from 'express'
import { createOrder, verifyPayment, getHistory, paymentCallback } from '../controllers/paymentController.js'
import { protect } from '../middleware/auth.js'

const router = Router()

// PhonePe calls this server-to-server — must NOT require user auth
router.post('/callback', paymentCallback)

// Everything below requires a logged-in user
router.use(protect)
router.post('/order',   createOrder)
router.post('/verify',  verifyPayment)
router.get('/history',  getHistory)

export default router