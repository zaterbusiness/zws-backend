import { Router } from 'express'
import { getStatus, createOrder, verifyPayment, getHistory } from '../controllers/subscriptionController.js'
import { protect } from '../middleware/auth.js'

const router = Router()
router.use(protect)
router.get('/status',  getStatus)
router.post('/order',  createOrder)
router.post('/verify', verifyPayment)
router.get('/history', getHistory)
export default router
