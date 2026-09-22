import { Router } from 'express'
import {
  createProject,
  getUserProjects,
  getProject,
  getProjectStatus,
  downloadProject,
  deleteProject,
  updateProjectTitle,
  saveTemplate,
  regenerateProject,
  getProjectQuestions,      // add
  submitProjectAnswers,     // add
} from '../controllers/projectController.js'


import { protect } from '../middleware/auth.js'
import { checkCreditsOnly, requirePayment } from '../middleware/creditsCheck.js'
import { modeGuard } from '../middleware/modeGuard.js'

const router = Router()
router.use(protect)

router.post('/template',       saveTemplate)
router.post('/',               modeGuard('website'), checkCreditsOnly(100), createProject)
router.get('/',                getUserProjects)
router.get('/:id',             getProject)
router.get('/:id/status',      getProjectStatus)
router.get('/:id/download',    requirePayment, downloadProject)
router.put('/:id',             updateProjectTitle)
router.post('/:id/regenerate', modeGuard('website'), checkCreditsOnly(100), regenerateProject)
router.delete('/:id',          deleteProject)
// ...existing routes...
router.get('/:id/questions',  getProjectQuestions)
router.post('/:id/answers',  submitProjectAnswers) 
export default router