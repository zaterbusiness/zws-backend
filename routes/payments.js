import { Router } from 'express'
import { createOrder, verifyPayment, getHistory } from '../controllers/paymentController.js'
import { protect } from '../middleware/auth.js'

const router = Router()
router.use(protect)
router.post('/order',   createOrder)
router.post('/verify',  verifyPayment)
router.get('/history',  getHistory)
export default router
