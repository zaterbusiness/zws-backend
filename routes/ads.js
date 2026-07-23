import { Router } from 'express'
import {
  getActiveAd, recordAdClick,
  getAds, createAd, updateAd, deleteAd,
  getViewStats
} from '../controllers/adController.js'
import { adminProtect } from '../middleware/adminAuth.js'

const router = Router()

// Public
router.get('/active',        getActiveAd)
router.post('/click/:id',    recordAdClick)

// Admin protected
router.get('/admin/list',    adminProtect, getAds)
router.post('/admin/create', adminProtect, createAd)
router.put('/admin/:id',     adminProtect, updateAd)
router.delete('/admin/:id',  adminProtect, deleteAd)
router.get('/admin/views',   adminProtect, getViewStats)

export default router
