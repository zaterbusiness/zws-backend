import express from 'express'
import fetch from 'node-fetch'
import pool from '../config/db.js'

const router = express.Router()


router.post('/apps/:id/deploy', async (req, res) => {
  const { id } = req.params
  try {
    const [rows] = await pool.query('SELECT * FROM apps WHERE id = ?', [id])
    const app = rows[0]
    if (!app) return res.status(404).json({ error: 'App not found' })

    // 1. Deploy frontend to Vercel (no GitHub needed — direct file upload)
    const vercelRes = await fetch('https://api.vercel.com/v13/deployments', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${process.env.VERCEL_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        name: `zws-${id}`,
        target: 'production', 
       files: [
  { file: 'src/App.js', data: Buffer.from(app.frontend || '').toString('base64'), encoding: 'base64' },
  { file: 'src/index.js', data: Buffer.from(
      `import React from 'react'\nimport ReactDOM from 'react-dom/client'\nimport App from './App'\nReactDOM.createRoot(document.getElementById('root')).render(<App />)`
    ).toString('base64'), encoding: 'base64' },
  { file: 'public/index.html', data: Buffer.from(
      `<!DOCTYPE html><html><head><title>${app.title || 'App'}</title></head><body><div id="root"></div></body></html>`
    ).toString('base64'), encoding: 'base64' },
  { file: 'package.json', data: Buffer.from(JSON.stringify({
      name: `zws-${id}`,
      version: '1.0.0',
      scripts: { build: 'react-scripts build', start: 'react-scripts start' },
      dependencies: {
        react: '^18.2.0',
        'react-dom': '^18.2.0',
        'react-scripts': '5.0.1'
      },
      browserslist: { production: ['>0.2%', 'not dead', 'not op_mini all'] }
    }, null, 2)).toString('base64'), encoding: 'base64' }
],
        projectSettings: { framework: 'create-react-app' },
      }),
    })
    const vercelData = await vercelRes.json()
if (!vercelRes.ok) throw new Error(vercelData.error?.message || 'Vercel deploy failed')

const liveUrl = `https://${vercelData.url}`
await pool.query(
  'UPDATE apps SET deploy_url = ?, vercel_project_id = ? WHERE id = ?',
  [liveUrl, vercelData.projectId, id]   // <-- ADD vercelData.projectId
)

res.json({ url: liveUrl })
  } catch (err) {
    console.error('Deploy error:', err)
    res.status(500).json({ error: err.message })
  }
})

export default router