// routes/preview.js
import { Router } from 'express'
import { getProjectHtmlById } from '../controllers/projectController.js'

const router = Router()

// No auth middleware — this must be publicly fetchable by the iframe,
// but it only ever returns raw HTML, never JSON/API data.
router.get('/:id', async (req, res) => {
  const html = await getProjectHtmlById(req.params.id)
  if (!html) return res.status(404).send('Not found')

  res.set('Content-Type', 'text/html')
  // Critical: prevents this response from being framed anywhere except
  // the subdomain you control, and blocks it from ever loading your main app.
  res.set('Content-Security-Policy', "frame-ancestors 'self'")
  res.send(html)
})

export default router