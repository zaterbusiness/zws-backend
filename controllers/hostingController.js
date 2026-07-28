import crypto from 'crypto'
import { v4 as uuidv4 } from 'uuid'
import fs   from 'fs'
import path from 'path'
import { query, queryOne } from '../config/db.js'
import { initiatePhonePePayment, checkPhonePeStatus } from '../config/phonepe.js'

const HOSTING_PRICE = 49900 // ₹499 in paise
const BASE_DOMAIN   = process.env.BASE_DOMAIN || 'zws.com'  // zws.sitename.com
const HOSTED_DIR    = process.env.HOSTED_DIR  || path.join(process.cwd(), 'hosted_sites')

// Make slug from title: "My Yoga Studio" → "my-yoga-studio"
const toSlug = (text) =>
  text.toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .trim()
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .slice(0, 40) || 'my-site'

// Ensure hosted_sites directory exists
if (!fs.existsSync(HOSTED_DIR)) {
  fs.mkdirSync(HOSTED_DIR, { recursive: true })
  console.log(`📁 Created hosted sites directory: ${HOSTED_DIR}`)
}

// ── GET /api/hosting/check-subdomain?name=xxx ─────────────────
export const checkSubdomain = async (req, res) => {
  try {
    const { name } = req.query
    if (!name?.trim()) return res.status(400).json({ error: 'Subdomain name required.' })

    const slug      = toSlug(name.trim())
    const subdomain = `${slug}.${BASE_DOMAIN}`

    const existing = await queryOne(
      'SELECT id FROM projects WHERE hosted_subdomain=? AND hosting_paid=1',
      [subdomain]
    )

    res.json({
      subdomain,
      available: !existing,
      fullUrl:   `https://${subdomain}`,
    })
  } catch (err) {
    res.status(500).json({ error: 'Check failed.' })
  }
}

// ── POST /api/hosting/order ───────────────────────────────────
// Create PhonePe order for ₹499 hosting
export const createHostingOrder = async (req, res) => {
  try {
    const { projectId, subdomain } = req.body

    if (!projectId)  return res.status(400).json({ error: 'projectId required.' })
    if (!subdomain)  return res.status(400).json({ error: 'subdomain required.' })

    const project = await queryOne(
      'SELECT * FROM projects WHERE id=? AND user_id=?',
      [projectId, req.user.id]
    )
    if (!project)               return res.status(404).json({ error: 'Project not found.' })
    if (project.status !== 'ready') return res.status(400).json({ error: 'Website must be ready before hosting.' })
    if (!project.download_paid) return res.status(400).json({ error: 'Please download first (₹499), then host.' })
    if (project.hosting_paid)   return res.status(400).json({ error: 'This project is already hosted.' })

    const slugged  = toSlug(subdomain)
    const fullSub  = `zws.${slugged}.${BASE_DOMAIN.replace('zws.', '')}`

    const taken = await queryOne(
      'SELECT id FROM projects WHERE hosted_subdomain=? AND hosting_paid=1',
      [fullSub]
    )
    if (taken) return res.status(400).json({ error: `Subdomain "${fullSub}" is already taken.` })

    const merchantTransactionId = `zws_host_${projectId.slice(0, 8)}_${Date.now()}`.slice(0, 40)

    const { redirectUrl } = await initiatePhonePePayment({
      amountPaise: HOSTING_PRICE,
      merchantUserId: String(req.user.id),
      merchantTransactionId,
      redirectUrl: `${process.env.FRONTEND_URL}/hosting/status?txnId=${merchantTransactionId}&projectId=${projectId}&subdomain=${fullSub}`,
      callbackUrl: `${process.env.BACKEND_URL}/api/hosting/callback`,
    })

    // Save pending hosting payment (reusing razorpay_order_id column for the PhonePe txn id)
    await query(
      `INSERT INTO hosting_payments
        (id, user_id, project_id, razorpay_order_id, amount, subdomain, status)
      VALUES (?,?,?,?,?,?,'created')`,
      [uuidv4(), req.user.id, projectId, merchantTransactionId, HOSTING_PRICE, fullSub]
    )

    console.log(`💳 Hosting order: ${merchantTransactionId} → ${fullSub}`)
    res.json({
      merchantTransactionId,
      redirectUrl,
      amount:    HOSTING_PRICE,
      currency:  'INR',
      subdomain: fullSub,
      fullUrl:   `https://${fullSub}`,
    })
  } catch (err) {
    console.error('createHostingOrder:', err)
    res.status(500).json({ error: 'Hosting payment setup failed.' })
  }
}

// ── POST /api/hosting/verify ──────────────────────────────────
// Verify payment + deploy site to hosted_sites folder
export const verifyHostingPayment = async (req, res) => {
  try {
    const { merchantTransactionId, projectId, subdomain } = req.body

    if (!merchantTransactionId) {
      return res.status(400).json({ error: 'Missing transaction id.' })
    }

    const statusRes = await checkPhonePeStatus(merchantTransactionId)

    if (statusRes?.code !== 'PAYMENT_SUCCESS') {
      await query(`UPDATE hosting_payments SET status='failed' WHERE razorpay_order_id=?`, [merchantTransactionId])
      return res.status(400).json({ error: 'Payment not successful.', code: statusRes?.code })
    }

    const providerTxnId = statusRes?.data?.transactionId || merchantTransactionId

    // Mark payment as paid
    await query(
      `UPDATE hosting_payments
      SET razorpay_payment_id=?, status='paid'
      WHERE razorpay_order_id=?`,
      [providerTxnId, merchantTransactionId]
    )

    // Get project HTML
    const project = await queryOne('SELECT * FROM projects WHERE id=? AND user_id=?', [projectId, req.user.id])
    if (!project?.generated_html) {
      return res.status(400).json({ error: 'Project HTML not found.' })
    }

    // ── Deploy: write HTML file to hosted_sites/subdomain/ ────
    const siteDir  = path.join(HOSTED_DIR, subdomain)
    const indexFile = path.join(siteDir, 'index.html')

    if (!fs.existsSync(siteDir)) {
      fs.mkdirSync(siteDir, { recursive: true })
    }

    const hostedHtml = injectHostingBadge(project.generated_html, subdomain)
    fs.writeFileSync(indexFile, hostedHtml, 'utf8')

    await query(
      `UPDATE projects
      SET hosting_paid=1, hosted_subdomain=?, hosted_at=NOW(), updated_at=NOW()
      WHERE id=? AND user_id=?`,
      [subdomain, projectId, req.user.id]
    )

    const fullUrl = `https://${subdomain}`
    console.log(`🌐 Site deployed: ${fullUrl}`)

    res.json({
      success:   true,
      subdomain,
      fullUrl,
      message:   `Your site is live at ${fullUrl}`,
    })
  } catch (err) {
    console.error('verifyHostingPayment:', err)
    res.status(500).json({ error: 'Hosting verification failed. Contact support.' })
  }
}

// ── POST /api/hosting/callback ────────────────────────────────
// PhonePe server-to-server callback (optional but recommended)
export const hostingPaymentCallback = async (req, res) => {
  try {
    console.log('PhonePe hosting callback received:', req.body)
    res.status(200).json({ received: true })
  } catch (err) {
    console.error('hostingPaymentCallback:', err)
    res.status(500).json({ error: 'Callback handling failed' })
  }
}

// ── GET /api/hosting/site/:subdomain ─────────────────────────
export const getHostedSite = async (req, res) => {
  try {
    const { subdomain } = req.params
    const indexFile = path.join(HOSTED_DIR, subdomain, 'index.html')

    if (!fs.existsSync(indexFile)) {
      return res.status(404).send(`
        <html><body style="font-family:sans-serif;text-align:center;padding:60px">
          <h2>404 — Site not found</h2>
          <p>The site <strong>${subdomain}</strong> does not exist.</p>
          <a href="https://zaterstudio.com">← Back to Zater</a>
        </body></html>
      `)
    }

    res.sendFile(indexFile)
  } catch (err) {
    res.status(500).send('Server error')
  }
}

export const getMySites = async (req, res) => {
  try {
    const githubSites = await query(
      `SELECT id, title, github_url, github_repo, template_name,
              created_at, updated_at
       FROM projects
       WHERE user_id = ? AND github_url IS NOT NULL AND github_url != ''
       ORDER BY updated_at DESC`,
      [req.user.id]
    )

    const sites = await query(
      `SELECT id, title, hosted_subdomain, hosted_at, created_at
       FROM projects
       WHERE user_id = ? AND hosting_paid = 1
       ORDER BY hosted_at DESC`,
      [req.user.id]
    )

    const apps = await query(
      `SELECT id, title, prompt, deploy_url, created_at, updated_at
       FROM apps
       WHERE user_id = ? AND deploy_url IS NOT NULL AND deploy_url != ''
       ORDER BY updated_at DESC`,
      [req.user.id]
    )

    res.json({ githubSites: githubSites || [], sites: sites || [], apps: apps || [] })
  } catch (err) {
    console.error('getMySites error:', err.message)
    res.status(500).json({ error: err.message })
  }
}

// ── Inject "Hosted by Zater" badge ───────────────────────────
const injectHostingBadge = (html, subdomain) => {
  const badge = `
<style>
  #zws-badge{
    position:fixed;bottom:16px;right:16px;z-index:99999;
    background:rgba(10,10,18,0.88);color:#fff;
    padding:6px 12px;border-radius:100px;
    font-family:system-ui,sans-serif;font-size:11px;font-weight:700;
    letter-spacing:0.3px;display:flex;align-items:center;gap:6px;
    box-shadow:0 2px 12px rgba(0,0,0,0.3);text-decoration:none;
    backdrop-filter:blur(8px);border:1px solid rgba(255,255,255,0.1);
  }
  #zws-badge:hover{opacity:0.85;}
  #zws-badge span{width:7px;height:7px;border-radius:50%;background:#22c55e;flex-shrink:0;}
</style>
<a id="zws-badge" href="https://zaterstudio.com" target="_blank">
  <span></span> Hosted by Zater
</a>`
  if (html.includes('</body>')) {
    return html.replace('</body>', `${badge}\n</body>`)
  }
  return html + badge
}