import { Router } from 'express'
import {
  createApp, clarifyApp, getUserApps, getApp, getAppStatus,
  downloadApp, updateAppTitle, regenerateApp, deleteApp,
  downloadAppZip, downloadAppApk,
  deployApp, undeployApp,                                 // ← add undeployApp here
  connectCustomDomain, checkDomainStatus, removeCustomDomain,
  checkDeployStatus
} from '../controllers/appController.js' 
import { protect } from '../middleware/auth.js'
import { pushToGithub } from '../controllers/appController.js'
// ...



const router = Router()
router.use(protect)

router.post('/clarify',           clarifyApp)
router.post('/',                  createApp)
router.get('/',                   getUserApps)
router.get('/:id',                getApp)
router.get('/:id/status',         getAppStatus)
router.get('/:id/download',       downloadApp)
router.get('/:id/download-zip',   downloadAppZip)
router.get('/:id/download-apk',   downloadAppApk)
router.put('/:id',                updateAppTitle)

router.post('/:id/regenerate',    regenerateApp)
router.delete('/:id',             deleteApp)

router.post('/:id/deploy',        deployApp)          // ← this was missing here too — check you have it wired somewhere already, or add it

router.post('/:id/domain',          connectCustomDomain)
router.get('/:id/domain/status',    checkDomainStatus)
router.delete('/:id/domain',        removeCustomDomain)
router.post('/:id/github-push', pushToGithub)
router.delete('/:id/deploy',      undeployApp)   // ← new: remove deployment only
router.get('/:id/deploy-status',  checkDeployStatus)   // ← fixed: was '/apps/:id/deploy-status', which double-prefixed to /apps/apps/:id/... since this router is already mounted at /apps
export default router