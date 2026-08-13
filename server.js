import dotenv from 'dotenv'
dotenv.config()
import express       from 'express'
import cors          from 'cors'
import path          from 'path'
import { fileURLToPath } from 'url'
import { testConnection } from './config/db.js'
import authRoutes    from './routes/auth.js'
import projectRoutes from './routes/projects.js'
import paymentRoutes from './routes/payments.js'
import appRoutes     from './routes/apps.js'

import adminRoutes from './routes/admin.js'
import adsRoutes from './routes/ads.js'
import hostingRoutes from './routes/hosting.js'
import deployRoutes from './routes/deploy.js'
import analyticsRoutes from './routes/analytics.js'
// ...


// Public, no-credentials CORS just for the tracking beacon —
// must be registered before the global cors() middleware




import creditsRouter from './routes/credits.js'
// Add this import at the top with your other imports
import claudeRoutes from './routes/claude.js'

// Add this with your other routes
import dns from 'dns'
dns.setDefaultResultOrder('ipv4first')
dotenv.config()

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const app       = express()
const PORT      = process.env.PORT || 5000
const HOSTED_DIR = process.env.HOSTED_DIR || path.join(__dirname, 'hosted_sites')

// Public, no-credentials CORS just for the tracking beacon — must come before global cors()
app.use('/api/analytics/track', cors({ origin: true, credentials: false }))

app.use(cors({
  origin:         process.env.FRONTEND_URL || 'http://localhost:5173',
  credentials:    true,
  methods:        ['GET','POST','PUT','DELETE','OPTIONS'],
  allowedHeaders: ['Content-Type','Authorization'],
}))
app.use(express.json({ limit: '20mb' }))
app.use(express.urlencoded({ extended: true }))
app.use((req, _, next) => { console.log(`${req.method} ${req.path}`); next() })
app.use('/api/credits', creditsRouter)
app.post('/api/ads/page-view', (req, res) => {
    try {
        const data = req.body;
        console.log('Page view received:', data);
        
        // Process the data (e.g., save to database)
        
        res.status(200).json({ message: 'Page view tracked successfully' });
    } catch (error) {
        res.status(500).json({ error: 'Internal Server Error' });
    }
});
// ...
// app.use('/api/auth/github', githubAuthRoutes)
// ── API routes ────────────────────────────────────────────────
app.use('/api/auth',     authRoutes)
app.use('/api/projects', projectRoutes)
app.use('/api/payments', paymentRoutes)
app.use('/api/apps',     appRoutes)
app.use('/api/hosting',  hostingRoutes)
app.use('/api/admin',    adminRoutes)
app.use('/api/ads',      adsRoutes)
app.use('/api/claude',   claudeRoutes)   // ← add here
app.use('/api', deployRoutes)
app.use('/api/analytics', analyticsRoutes)
// After app.use('/sites', express.static(HOSTED_DIR)):
app.use('/uploads', express.static(path.join(__dirname, 'uploads')))

// ── Serve hosted sites as static files ───────────────────────
// In production: your reverse proxy (Nginx) handles subdomain routing
// In dev: access via GET /api/hosting/site/:subdomain
app.use('/sites', express.static(HOSTED_DIR))

app.use((req, res) => res.status(404).json({ error: `Not found: ${req.method} ${req.path}` }))
app.use((err, _req, res, _next) => { console.error(err); res.status(500).json({ error: 'Server error' }) })
app.use('/api/analytics/track', cors({ origin: true, credentials: false }))
const start = async () => {
  const ok = await testConnection()
  if (!ok) { console.error('Fix MySQL then restart.'); process.exit(1) }
  app.listen(PORT, () => {
    console.log('')
    console.log('  ⚡ Zater AI Studio API')
    console.log(`  🚀 http://localhost:${PORT}`)
    console.log(`  🌐 Hosted sites dir: ${HOSTED_DIR}`)
    console.log(`  🔗 Domain: ${process.env.BASE_DOMAIN || 'zws.com'}`)
    console.log('')
  })
}
start()
