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
  getProjectQuestions,
  submitProjectAnswers,
  editProject,
  getVersions,
  restoreVersion,
  getVersionHtml,
} from '../controllers/projectController.js'
import { deployVersionToGithub } from '../controllers/versionHostingController.js'
// replace the old github-pages route with this one


// replace the old github-pages route with this one

import { protect } from '../middleware/auth.js'
import { checkCreditsOnly, requirePayment } from '../middleware/creditsCheck.js'
import { modeGuard } from '../middleware/modeGuard.js'
import { getEditQuestions } from '../controllers/projectController.js'
   // same middleware as your /edit route
const router = Router()
router.use(protect)

router.post('/template',       saveTemplate)
router.post('/',               modeGuard('website'), checkCreditsOnly(100), createProject)
router.get('/',                getUserProjects)
router.get('/:id',             getProject)
router.get('/:id/status',      getProjectStatus)
router.get('/:id/download',    requirePayment, downloadProject)
router.put('/:id',             updateProjectTitle)
router.delete('/:id',          deleteProject)
router.get('/:id/questions',   getProjectQuestions)
router.post('/:id/answers',    submitProjectAnswers)
router.get('/:id/versions/:versionNo', getVersionHtml)
router.post('/:id/edit/questions', getEditQuestions)
// Edit flow (credits are checked inside editProject so the 402 carries purchase info)
router.post('/:id/edit',               editProject)
router.get('/:id/versions',            getVersions)
router.post('/:id/restore/:versionNo', restoreVersion)
router.post('/github-pages', protect, deployVersionToGithub)
export default router