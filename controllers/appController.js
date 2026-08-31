import Anthropic from '@anthropic-ai/sdk'
import { v4 as uuidv4 } from 'uuid'
import { query, queryOne } from '../config/db.js'
import { createRequire } from 'module'

import { Client } from 'pg'
import { pushFullProjectToGithub } from '../services/deployService.js'
export const pushToGithub = async (req, res) => {
  try {
    const a = await queryOne('SELECT * FROM apps WHERE id = ? AND user_id = ?', [req.params.id, req.user.id])
    if (!a) return res.status(404).json({ error: 'App not found.' })
    if (a.status !== 'ready') return res.status(400).json({ error: 'App is not ready yet.' })
    if (a.github_repo_url) return res.json({ url: a.github_repo_url, alreadyPushed: true })
    const files = a.frontend_files
      ? (typeof a.frontend_files === 'string' ? JSON.parse(a.frontend_files) : a.frontend_files)
      : { 'src/App.jsx': a.frontend }
    const { repoUrl } = await pushFullProjectToGithub(a, files)
    await query('UPDATE apps SET github_repo_url=?, updated_at=NOW() WHERE id=?', [repoUrl, a.id])
    res.json({ url: repoUrl })
  } catch (err) {
    console.error('pushToGithub error:', err)
    res.status(500).json({ error: 'GitHub push failed: ' + err.message })
  }
}

const require = createRequire(import.meta.url)

const archiverModule = require('archiver')
const archiver = archiverModule.default || archiverModule

// ─── DOWNLOAD ZIP ─────────────────────────────────────────────────────────────
export const downloadAppZip = async (req, res) => {
  try {
    const app = await queryOne(
      `SELECT * FROM apps WHERE id = ? AND user_id = ?`,
      [req.params.id, req.user.id]
    )
    if (!app) return res.status(404).json({ error: 'App not found' })
    if (app.status !== 'ready') return res.status(400).json({ error: 'App not ready' })
    if (!app.frontend || !app.backend || !app.schema_sql) {
      return res.status(400).json({ error: 'App files were not fully generated' })
    }

    const safeName = (app.title || 'app').replace(/[^a-z0-9]/gi, '_')

    res.setHeader('Content-Type', 'application/zip')
    res.setHeader('Content-Disposition', `attachment; filename="${safeName}.zip"`)

    const archive = archiver('zip', { zlib: { level: 9 } })
    archive.on('error', err => { console.error('ZIP error:', err); res.end() })
    archive.pipe(res)

    const files = app.frontend_files
  ? (typeof app.frontend_files === 'string' ? JSON.parse(app.frontend_files) : app.frontend_files)
  : { 'src/App.jsx': app.frontend }

for (const [path, content] of Object.entries(files)) {
  archive.append(content, { name: `frontend/${path}` })
}
archive.append(app.backend, { name: 'backend/server.js' })
archive.append(app.schema_sql, { name: 'backend/schema.sql' })
archive.append(
  JSON.stringify({
    name: 'backend',
    version: '1.0.0',
    main: 'server.js',
    scripts: { start: 'node server.js' },
    dependencies: {
      express: '^4.19.2',
      cors: '^2.8.5',
      '@supabase/supabase-js': '^2.45.0',
      jsonwebtoken: '^9.0.2',
      bcryptjs: '^2.4.3',
      dotenv: '^16.4.5',
    },
  }, null, 2),
  { name: 'backend/package.json' }
)
archive.append(app.readme || `# ${app.title}\n`, { name: 'README.md' })

    await archive.finalize()
  } catch (err) {
    console.error('downloadAppZip error:', err)
    res.status(500).json({ error: err.message })
  }
}

// ─── DOWNLOAD APK PROJECT ──────────────────────────────────────────────────────
export const downloadAppApk = async (req, res) => {
  try {
    const app = await queryOne(
      `SELECT * FROM apps WHERE id = ? AND user_id = ?`,
      [req.params.id, req.user.id]
    )
    if (!app) return res.status(404).json({ error: 'App not found' })
    if (app.status !== 'ready') return res.status(400).json({ error: 'App not ready' })
    if (!app.frontend) {
      return res.status(400).json({ error: 'App frontend was not generated' })
    }

    const safeName = (app.title || 'app').replace(/[^a-z0-9]/gi, '_').toLowerCase()

    res.setHeader('Content-Type', 'application/zip')
    res.setHeader('Content-Disposition', `attachment; filename="${safeName}_apk_project.zip"`)

    const archive = archiver('zip', { zlib: { level: 9 } })
    archive.on('error', err => { console.error('APK ZIP error:', err); res.end() })
    archive.pipe(res)

    // Wrap the generated App.jsx in a minimal static HTML shell using CDN React,
    // since a Capacitor WebView needs plain HTML/JS, not raw unbundled JSX.
    const wrappedHtml = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${app.title}</title>
  <script src="https://unpkg.com/react@18/umd/react.production.min.js"></script>
  <script src="https://unpkg.com/react-dom@18/umd/react-dom.production.min.js"></script>
  <script src="https://unpkg.com/@babel/standalone/babel.min.js"></script>
</head>
<body>
  <div id="root"></div>
  <script type="text/babel" data-presets="react">
${stripModuleSyntax(app.frontend)}

const root = ReactDOM.createRoot(document.getElementById('root'));
root.render(<App />);
  </script>
</body>
</html>`

    archive.append(wrappedHtml, { name: 'www/index.html' })

    archive.append(JSON.stringify({
      appId: `in.zater.${safeName}`,
      appName: app.title || 'My App',
      webDir: 'www',
      server: { androidScheme: 'https' }
    }, null, 2), { name: 'capacitor.config.json' })

    archive.append(JSON.stringify({
      name: safeName,
      version: '1.0.0',
      description: `${app.title} — generated by Zater Web Studio`,
      scripts: {
        'build:android': 'npx cap add android && npx cap sync android && npx cap open android'
      },
      dependencies: {
        '@capacitor/android': '^5.0.0',
        '@capacitor/core': '^5.0.0'
      },
      devDependencies: {
        '@capacitor/cli': '^5.0.0'
      }
    }, null, 2), { name: 'package.json' })

    archive.append(`# ${app.title} — APK Build Instructions

Generated by Zater Web Studio

## Requirements
- Node.js 18+
- Android Studio (https://developer.android.com/studio)
- Java JDK 17+

## Steps

1. Install dependencies:
   npm install

2. Add Android and open Android Studio:
   npm run build:android

3. In Android Studio:
   Build → Build Bundle(s) / APK(s) → Build APK(s)
   Output: android/app/build/outputs/apk/debug/app-debug.apk

## App Details
- App ID : in.zater.${safeName}
- App Name: ${app.title}

## Note
This APK loads React from CDN at runtime and uses Babel standalone to transpile JSX in-browser (for speed of setup). For a production release, replace this with a proper Vite/CRA build output in the www/ folder before building the final APK.
`, { name: 'README.md' })

    await archive.finalize()
  } catch (err) {
    console.error('downloadAppApk error:', err)
    res.status(500).json({ error: err.message })
  }
}
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })

const APP_GEN_MODEL = 'claude-opus-4-8'
const APP_GEN_CREDITS = 200

// ─── SYSTEM PROMPT ────────────────────────────────────────────────────────────
const APP_PROMPT = `You are Zater AI Studio — an expert full-stack app generator.
Generate a complete full-stack application built as a real mobile app (via Capacitor) that also runs fine on laptop browsers, and can be deployed MANUALLY by the user on any host (VPS, shared hosting, their own machine) with zero external services required.

═══════════════════════════════════════════════
ABSOLUTE OUTPUT RULES (never break these):
═══════════════════════════════════════════════
1. Return ONLY a raw valid JSON object. No markdown, no backticks, no explanation before or after.
2. JSON must have EXACTLY these 4 top-level keys: frontend, backend, schema, readme
3. "frontend" is a JSON OBJECT mapping file paths to complete file contents — not a single string.
4. All values are COMPLETE, non-truncated strings. Never use placeholder comments like "// add code here" or "// rest of code".
5. Never stop generating mid-file. Every file must be 100% complete.

Return this EXACT JSON structure:
{
  "frontend": {
    "index.html": "root HTML file with <meta name='viewport' content='width=device-width, initial-scale=1, viewport-fit=cover'> (viewport-fit=cover required for safe-area-inset to work on notched devices), links to src/main.jsx as module script, sets a dark theme-color meta tag",
    "src/main.jsx": "React entry point, mounts <App /> wrapped in <BrowserRouter>",
    "src/App.jsx": "Defines <Routes> for every page, renders <Layout> which switches between <BottomTabBar/> (mobile) and <Sidebar/> (tablet/laptop) via CSS media queries — not JS device detection",
    "src/api.js": "single fetch wrapper reading the API base URL from import.meta.env.VITE_API_URL, with helper functions for each backend endpoint, attaching the JWT from localStorage to protected calls",
    "src/pages/Login.jsx": "...",
    "src/pages/Signup.jsx": "...",
    "src/pages/Dashboard.jsx": "the main feature screen(s) — split into more page files if the feature needs more than one screen. Built with flex/grid layouts that reflow at 768px and 1024px breakpoints — no fixed pixel-width containers",
    "src/components/BottomTabBar.jsx": "fixed bottom tab nav, visible only below 768px via CSS, icons + labels for each main page, each tap target at least 44x44px, bottom padding respects safe-area-inset for notched devices",
    "src/components/Sidebar.jsx": "left sidebar nav, visible only at 768px and above via CSS, same page links as the tab bar",
    "src/index.css": "shared responsive styles: dark theme, mobile-first (base styles target <768px). Breakpoints: 768px (tablet — sidebar appears, grids go 1-col to 2-col) and 1024px (desktop — grids go 2-col to 3/4-col, max-width container with centered margins so content never full-bleeds on wide screens). Use CSS clamp() for fluid typography (e.g. font-size: clamp(1rem, 2vw, 1.25rem)) instead of fixed px jumps between breakpoints. All interactive elements (buttons, tab bar items, form inputs) min-height and min-width 44px for touch targets. Data tables convert to a stacked card layout below 768px instead of shrinking cells or requiring horizontal scroll. Images and media use max-width:100% and object-fit:cover, never fixed px widths. Add padding-bottom on the main content area equal to the bottom tab bar's height on mobile so content isn't hidden behind it, and use env(safe-area-inset-*) padding for notched devices",
    ".env.example": "VITE_API_URL=http://localhost:8000"
  },
  "backend": "complete Node.js Express server.js: express() app instance, cors middleware allowing all origins, a SQLite database opened via better-sqlite3 pointing at a local file './data.db' (created automatically if missing, path overridable via process.env.DB_PATH), JWT auth using jsonwebtoken for tokens and bcryptjs for password hashing, /auth/signup and /auth/login routes, full CRUD routes for the main feature using plain prepared statements (db.prepare(...).run/get/all — never string-concatenated SQL), an authMiddleware function verifying the JWT on protected routes, a small initDb() function that runs the schema.sql file on startup if tables don't exist yet (using fs.readFileSync + db.exec), and app.listen on process.env.PORT || 8000. One self-contained file, runnable with 'node server.js' — no external database service, no signup required anywhere.",
  "schema": "complete schema.sql file in SQLITE syntax: CREATE TABLE IF NOT EXISTS statements for every table needed (id INTEGER PRIMARY KEY AUTOINCREMENT, or TEXT PRIMARY KEY for UUIDs), proper FOREIGN KEY(...) REFERENCES(...) clauses, NOT NULL/UNIQUE constraints where relevant (e.g. UNIQUE on users.email), followed by INSERT OR IGNORE statements seeding at least 8 realistic sample rows per table. No Postgres/MySQL-only syntax (no SERIAL, no AUTO_INCREMENT keyword alone, no backticks) — pure SQLite.",
  "readme": "numbered setup steps for MANUAL, self-hosted deployment: 1-npm packages for frontend (react-router-dom) and how to copy .env.example to .env and set VITE_API_URL to wherever the backend will run 2-npm packages for backend (express, cors, better-sqlite3, jsonwebtoken, bcryptjs, dotenv) 3-backend env vars (JWT_SECRET, PORT, optional DB_PATH) 4-note that the SQLite database and tables are created automatically on first run from schema.sql, no separate database setup needed 5-how to run 'npm run build' on the frontend and serve the dist/ folder as static files (nginx, Apache, or any static host) 6-how to run the backend with 'node server.js' or a process manager like pm2 on a VPS 7-a note that if the user wants ZWS to deploy this for them instead of self-hosting, they can fill out the deployment request form linked in the ZWS dashboard"
}

Requirements:
- Every page is its own file under src/pages/ — no single giant App.jsx with everything inline
- Navigation must work identically whether rendered as a mobile app (Capacitor WebView, effectively always < 768px) or a laptop browser — same <Routes>, layout just swaps chrome via CSS
- All API calls go through src/api.js — no fetch() calls scattered directly in page components
- User authentication (signup + login with JWT stored in localStorage, verified via Express middleware on protected routes)
- Full CRUD for the main feature, using better-sqlite3 only — no Supabase, no MySQL, no MongoDB, no external DB service of any kind
- Real error handling and loading states on every async call
- At least 8 realistic sample/seed rows per table
- Input validation on both frontend and backend
- The app must run fully offline/locally with nothing but 'npm install' and env vars — no signup to any third-party service required to get it running
- Responsive at three tiers, not just nav chrome: mobile (<768px, single column, bottom tab bar), tablet (768-1024px, sidebar appears, 2-column grids), desktop (>1024px, sidebar, 3/4-column grids, centered max-width content area — never full-bleed on wide screens)
- Every page component (Dashboard, forms, lists, detail views) must be built with flex/grid that reflows at these breakpoints — no fixed pixel widths on containers, no horizontal scroll except where explicitly a carousel
- Long data tables must have a stacked/card view for mobile instead of shrinking table cells unreadably
- All tap targets (buttons, tab bar icons, form fields) at least 44x44px on mobile per standard touch guidelines`


// ─── CLARIFY PROMPT ───────────────────────────────────────────────────────────
const CLARIFY_PROMPT = `You are a pre-build analyst for Zater AI Studio's full-stack app generator. Your ONLY job is to decide whether a user's app request is specific enough to generate a correct React+Node+SQLite app on the first try, or whether it's ambiguous enough that generating now would waste 200 credits on a mismatched result.

Return ONLY a raw valid JSON object, no markdown, no backticks.

{
  "needs_clarification": true or false,
  "questions": [
    { "id": "main_entity", "question": "...", "options": ["...", "...", "..."] }
  ]
}

Rules:
- Only ask questions if the answer would change the database schema, CRUD routes, or page structure (e.g. "what's the core thing users create/manage?", "single-user tool or does it need multiple user roles?", "does it need any of: bookings, payments UI, messaging, file uploads?").
- Never ask about styling, colors, or naming — those have safe defaults.
- Max 3 questions. Each needs 2-4 short mutually-exclusive options.
- If the prompt already specifies the core entity, the user model, and the main workflow clearly (e.g. "task manager with projects, tasks, and team members" is already clear), set needs_clarification to false and return an empty array.
- Be decisive: most well-formed prompts should NOT need clarification. Only flag genuinely vague ones (e.g. "build me a CRM" with no domain, or "make an app for my business" with no detail).`

// ─── CLARIFY CONTROLLER ───────────────────────────────────────────────────────
export const clarifyApp = async (req, res) => {
  try {
    const { prompt } = req.body
    if (!prompt?.trim() || prompt.trim().length < 10) {
      return res.status(400).json({ error: 'Please describe your app in at least 10 characters.' })
    }

    const message = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001', // cheap triage call — not the real generation
      max_tokens: 500,
      system: CLARIFY_PROMPT,
      messages: [{ role: 'user', content: `User's app request: "${prompt.trim()}"` }]
    })

    const raw = message.content?.find(b => b.type === 'text')?.text || '{}'
    const parsed = extractJson(raw) // reuses your existing helper

    // No credit deduction here — this is a cheap triage step
    return res.json({
      needs_clarification: !!parsed.needs_clarification,
      questions: Array.isArray(parsed.questions) ? parsed.questions.slice(0, 3) : []
    })
  } catch (err) {
    console.error('clarifyApp error:', err.message)
    // Fail open — never block generation just because the clarify step broke
    return res.json({ needs_clarification: false, questions: [] })
  }
}

function extractJson(raw) {
  if (!raw) throw new Error('Empty response from Claude')

  // 1. Try direct parse first (best case — pure JSON output)
  try { return JSON.parse(raw.trim()) } catch (_) {}

  // 2. Strip markdown fences
  const stripped = raw.replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/\s*```$/i, '').trim()
  try { return JSON.parse(stripped) } catch (_) {}

  // 3. Extract the outermost {...} block (handles leading/trailing text)
  const start = raw.indexOf('{')
  const end   = raw.lastIndexOf('}')
  if (start !== -1 && end !== -1 && end > start) {
    try { return JSON.parse(raw.slice(start, end + 1)) } catch (_) {}
  }

  throw new Error('Could not extract valid JSON from Claude response')
}

/**
 * Validate that the parsed files object has all required keys
 * and that none of them are empty or obviously truncated.
 */ 

function validateFiles(files) {
  const required = ['frontend', 'backend', 'schema', 'readme']
  for (const key of required) {
    if (!files[key]) throw new Error(`Missing "${key}" in generated output`)
  }

  if (typeof files.frontend !== 'object' || Array.isArray(files.frontend)) {
    throw new Error('frontend must be an object of {filepath: content}')
  }

  const requiredFiles = ['src/main.jsx', 'src/App.jsx', 'src/api.js']
  for (const f of requiredFiles) {
    if (!files.frontend[f] || files.frontend[f].trim().length < 30) {
      throw new Error(`Missing or incomplete required file: ${f}`)
    }
  }
  if (Object.keys(files.frontend).filter(f => f.startsWith('src/pages/')).length === 0) {
    throw new Error('No page files found under src/pages/')
  }

  if (!files.backend.includes('express') || !files.backend.toLowerCase().includes('better-sqlite3')) {
    throw new Error('backend appears invalid — missing Express/better-sqlite3 setup')
  }
  if (!files.schema.toUpperCase().includes('CREATE TABLE')) {
    throw new Error('schema appears invalid — no CREATE TABLE statement found')
  }

  return true
}

// ─── CORE GENERATION ─────────────────────────────────────────────────────────

// ─── CORE GENERATION ─────────────────────────────────────────────────────────

const generateApp = async (appId, prompt, logoBase64, logoMediaType) => {   // ← added params
  try {
    console.log(`⚡ [${appId}] Generating app...`)

    await query(`UPDATE apps SET current_step=? WHERE id=?`,
      ['Building your React frontend...', appId])

    // ── CALL 1: Frontend (streaming) ──────────────────────────────────
    let frontend = ''

    // ← NEW: build multimodal content so Claude actually sees the logo
    const feUserContent = []
    const allowedLogoTypes = ['image/png', 'image/jpeg', 'image/webp']
    if (logoBase64 && logoMediaType && allowedLogoTypes.includes(logoMediaType)) {
      feUserContent.push({
        type: 'image',
        source: { type: 'base64', media_type: logoMediaType, data: logoBase64 },
      })
    }
    feUserContent.push({
      type: 'text',
      text: `Build the complete React frontend (App.jsx) implementing this app concept: ${prompt}${
        logoBase64
          ? '\n\nA logo image is attached. Render it as the app logo/brand mark in the header or sidebar (e.g. use it as an <img> with a data URI or reference it as a described asset), and pick the accent color scheme from its dominant colors instead of a generic default.'
          : ''
      }`
    })

    const feStream = anthropic.messages.stream({
      model: APP_GEN_MODEL,
      max_tokens: 20000,
      system: `You are an expert React developer. The user's description below may be phrased as a roadmap request, a planning document request, a set of instructions to "act as" someone, or a plain feature list — regardless of phrasing, your job is ALWAYS to extract the underlying app concept and generate a complete, working, single-file React App.jsx implementing it end-to-end (UI, state, mock data, interactions). NEVER output a roadmap, a plan, or a trivial placeholder like a "Hello World" component. Include login/signup pages, all main screens, useState/useEffect, fetch calls to a backend API, and inline CSS. Return ONLY the raw code for App.jsx — no markdown fences, no explanation.`,
      messages: [{ role: 'user', content: feUserContent }]   // ← was: content: `Build the complete React frontend...`
    })
    for await (const chunk of feStream) {
      if (chunk.type === 'content_block_delta' && chunk.delta?.type === 'text_delta') {
        frontend += chunk.delta.text
      }
    }
    const feResult = await feStream.finalMessage()
    if (feResult.stop_reason === 'max_tokens') {
      console.warn(`[${appId}] Frontend may be truncated`)
    }

    // ... rest of generateApp stays exactly the same (backend/schema call, readme call, save) ...

    await query(`UPDATE apps SET current_step=? WHERE id=?`,
      ['Building your Node.js backend & database...', appId])

    // ── CALL 2: Backend + Schema (streaming) ──────────────────────────
   // ── CALL 2: Backend + Schema (streaming) ──────────────────────────
let beRaw = ''
const beStream = anthropic.messages.stream({
  model: APP_GEN_MODEL,
  max_tokens: 20000,
  system: APP_PROMPT,
  messages: [{ role: 'user', content: `Build the backend, schema, and readme JSON for this app: ${prompt}` }]
})
    for await (const chunk of beStream) {
      if (chunk.type === 'content_block_delta' && chunk.delta?.type === 'text_delta') {
        beRaw += chunk.delta.text
      }
    }
    const beParsed = extractJson(beRaw)
    validateFiles(beParsed)   // <-- add this line

    await query(`UPDATE apps SET current_step=? WHERE id=?`,
      ['Writing your setup guide...', appId])

    // ── CALL 3: README (streaming) ────────────────────────────────────
  // ── CALL 3: README (streaming) ────────────────────────────────────
let readme = ''
const rmStream = anthropic.messages.stream({
  model: APP_GEN_MODEL,
  max_tokens: 4000,
  system: `Write a clear, numbered setup guide (README) for a full-stack app: npm packages to install, env variables needed, how to run the SQL schema, how to start frontend and backend servers, and how to open in browser. Return ONLY the README markdown text.`,
  messages: [{ role: 'user', content: `Write the README for this app: ${prompt}` }]
})
    for await (const chunk of rmStream) {
      if (chunk.type === 'content_block_delta' && chunk.delta?.type === 'text_delta') {
        readme += chunk.delta.text
      }
    }
    readme = readme.trim()

    // ── Validate ── (unchanged)

    await query(`UPDATE apps SET current_step=? WHERE id=?`,
      ['Finalizing your app...', appId])

    // ── Save ──────────────────────────────────────────────────────────
    await query(
      `UPDATE apps
          SET frontend=?, backend=?, schema_sql=?, readme=?,
              status='ready', current_step=NULL, updated_at=NOW()
        WHERE id=?`,
      [frontend, beParsed.backend, beParsed.schema, readme, appId]
    )

    const app = await queryOne('SELECT user_id FROM apps WHERE id = ?', [appId])
    if (app) {
      await query('UPDATE users SET credits = credits - ? WHERE id = ?', [APP_GEN_CREDITS, app.user_id])
    }

    console.log(`✅ [${appId}] App ready`)
  } catch (err) {
    await query(`UPDATE apps SET status='failed', current_step=NULL, updated_at=NOW() WHERE id=?`, [appId])
    console.error(`❌ [${appId}] Generation failed:`, err.message)
    throw err
  }
}
function validateFrontend(code) {
  if (!code || code.trim().length < 500) {
    return { valid: false, reason: 'Frontend too short — likely a stub' }
  }
  if (!code.includes('useState') && !code.includes('useEffect')) {
    return { valid: false, reason: 'Frontend has no real interactivity' }
  }
  return { valid: true }
}

// ─── CONTROLLERS ─────────────────────────────────────────────────────────────

// ─── CONTROLLERS ─────────────────────────────────────────────────────────────

export const createApp = async (req, res) => {
  try {
    const { prompt, title, logoBase64, logoMediaType, clarificationAnswers } = req.body

    if (!prompt?.trim() || prompt.trim().length < 10) {
      return res.status(400).json({ error: 'Please describe your app in at least 10 characters.' })
    }

    const finalPrompt = clarificationAnswers && Object.keys(clarificationAnswers).length > 0
      ? `${prompt.trim()}\n\nAdditional details from user:\n${Object.entries(clarificationAnswers)
          .map(([k, v]) => `- ${k}: ${v}`).join('\n')}`
      : prompt.trim()

    const userId = req.user.id

    // Check credits before doing anything
    const user = await queryOne('SELECT credits FROM users WHERE id = ?', [userId])
    if (!user || user.credits < APP_GEN_CREDITS) {
      return res.status(402).json({ error: 'Insufficient credits. Please purchase more credits.' })
    }

    // Block if user already has a generation in progress
    const inProgress = await queryOne(
      `SELECT id FROM apps WHERE user_id = ? AND status = 'generating'`,
      [userId]
    )
    if (inProgress) {
      return res.status(429).json({ error: 'You already have an app generating. Please wait for it to finish.' })
    }

    const id     = uuidv4()
    const ptitle = title?.trim() || prompt.trim().slice(0, 80)

    await query(
      `INSERT INTO apps (id, user_id, title, prompt, status, download_paid, current_step)
       VALUES (?, ?, ?, ?, 'generating', 0, 'Analyzing your prompt...')`,
      [id, userId, ptitle, finalPrompt]
    )

    res.status(201).json({ appId: id, status: 'generating', message: 'App generation started!' })

    // Fire and forget
    generateApp(id, finalPrompt, logoBase64, logoMediaType)
      .catch(err => console.error(`[${id}] Background generation error:`, err.message))

  } catch (err) {
    console.error('createApp controller error:', err)
    res.status(500).json({ error: 'Failed to create app.' })
  }
}

export const getUserApps = async (req, res) => {
  try {
    const apps = await query(
      `SELECT id, title, prompt, status, download_paid, created_at
         FROM apps
        WHERE user_id = ?
        ORDER BY created_at DESC`,
      [req.user.id]
    )
    res.json({ apps })
  } catch (err) {
    console.error('getUserApps error:', err)
    res.status(500).json({ error: 'Failed to fetch apps.' })
  }
}

function stripModuleSyntax(code) {
  const lines = code.split('\n')
  const out = []
  let skipping = false
  let depth = 0

  for (let line of lines) {
    if (!skipping && /^\s*import\s/.test(line)) {
      skipping = true
      depth += (line.match(/{/g) || []).length - (line.match(/}/g) || []).length
      if (depth <= 0 && /;|['"]$/.test(line.trim())) skipping = false
      continue
    }
    if (skipping) {
      depth += (line.match(/{/g) || []).length - (line.match(/}/g) || []).length
      if (depth <= 0) skipping = false
      continue
    }
    out.push(line)
  }

  return code
    // import X, { a, b } from 'mod';  — handles multi-line named imports
    .replace(/import\s+[\s\S]*?from\s+['"][^'"]+['"]\s*;?/g, '')
    // import 'mod';  — side-effect-only imports
    .replace(/import\s+['"][^'"]+['"]\s*;?/g, '')
    .replace(/export\s+default\s+function\s+/g, 'function ')
    .replace(/export\s+default\s+/g, '')
    .replace(/export\s+(const|function|class)\s+/g, '$1 ')
    .replace(/import\(['"][^'"]+['"]\)/g, 'null') // neutralize dynamic imports
}

async function performDeployment(app) {
  const safeName = (app.title || 'app')
  .toLowerCase()
  .replace(/^(create|build)\s+an?\s+/, '')   // strip "create a "
  .split(/\s+/).slice(0, 4).join('-')          // first 4 words only
  .replace(/[^a-z0-9-]/g, '')
  .slice(0, 40) || `app-${app.id.slice(0, 8)}`

  // Wrap the generated React frontend in a static HTML shell (CDN React),
  // same approach as your APK export — Vercel just needs static files.
  const indexHtml = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${app.title}</title>
  <script src="https://unpkg.com/react@18/umd/react.production.min.js"></script>
  <script src="https://unpkg.com/react-dom@18/umd/react-dom.production.min.js"></script>
  <script src="https://unpkg.com/@babel/standalone/babel.min.js"></script>
</head>
<body>
  <div id="root"></div>
  <script type="text/babel" data-presets="react">
const { useState, useEffect, useRef, useContext, useMemo, useCallback, useReducer, Fragment } = React;

${stripModuleSyntax(app.frontend)}

const root = ReactDOM.createRoot(document.getElementById('root'));
root.render(<App />);
  </script>
</body>
</html>`

  const res = await fetch('https://api.vercel.com/v13/deployments', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${VERCEL_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      name: safeName,
      target: 'production',
      files: [
        {
          file: 'index.html',
          data: Buffer.from(indexHtml, 'utf-8').toString('base64'),
          encoding: 'base64',
        },
      ],
      projectSettings: { framework: null },
    }),
  })

  const data = await res.json()

  if (!res.ok) {
    throw new Error(data.error?.message || 'Vercel deployment failed')
  }

  // data.url is the deployment hostname (no protocol), projectId lets us manage custom domains later
  return {
    url: `https://${data.url}`,
    projectId: data.projectId,
  }
}
import { pushBackendToGithub, deployBackendToRender, provisionSupabaseSchema } from '../services/deployService.js'

export const deployApp = async (req, res) => {
  try {
    const a = await queryOne('SELECT * FROM apps WHERE id = ? AND user_id = ?', [req.params.id, req.user.id])
    if (!a) return res.status(404).json({ error: 'App not found.' })
    if (a.status !== 'ready') return res.status(400).json({ error: 'App is not ready to deploy.' })

    const schemaName = await provisionSupabaseSchema(a.id, a.schema_sql)

    const { owner, repoName } = await pushBackendToGithub(a.id, {
      'server.js': a.backend,
      'package.json': JSON.stringify({
        name: 'backend', version: '1.0.0', main: 'server.js',
        scripts: { start: 'node server.js' },
        dependencies: {
          express: '^4.19.2', cors: '^2.8.5', '@supabase/supabase-js': '^2.45.0',
          jsonwebtoken: '^9.0.2', bcryptjs: '^2.4.3', dotenv: '^16.4.5',
        },
      }, null, 2),
    })
    const { serviceId, url: backendUrl } = await deployBackendToRender(a.id, owner, repoName)

    const { url: deployUrl, projectId } = await performDeployment(a, backendUrl) // pass backendUrl in

    await query(
      `UPDATE apps SET deploy_url=?, vercel_project_id=?, render_service_id=?, backend_url=?, supabase_schema=?, updated_at=NOW() WHERE id=?`,
      [deployUrl, projectId, serviceId, backendUrl, schemaName, a.id]
    )

    res.json({ url: deployUrl, backendUrl })
  } catch (err) {
    console.error('deployApp error:', err)
    res.status(500).json({ error: 'Deployment failed: ' + err.message })
  }
}
export const getApp = async (req, res) => {
  try {
    const a = await queryOne(
      'SELECT * FROM apps WHERE id = ? AND user_id = ?',
      [req.params.id, req.user.id]
    )
    if (!a) return res.status(404).json({ error: 'App not found.' })

    res.json({
  app: {
    id: a.id, title: a.title, prompt: a.prompt, status: a.status,
    download_paid: a.download_paid,
    frontend: a.frontend,               // kept for old rows
    frontend_files: a.frontend_files,   // new
    backend: a.backend, schema_sql: a.schema_sql, readme: a.readme,
    deploy_url: a.deploy_url, created_at: a.created_at,
  }
})
  } catch (err) {
    console.error('getApp error:', err)
    res.status(500).json({ error: 'Failed to fetch app.' })
  }
}

export const getAppStatus = async (req, res) => {
  try {
    const a = await queryOne(
      'SELECT id, status, download_paid, current_step FROM apps WHERE id = ? AND user_id = ?',
      [req.params.id, req.user.id]
    )
    if (!a) return res.status(404).json({ error: 'App not found.' })
    res.json(a)
  } catch (err) {
    console.error('getAppStatus error:', err)
    res.status(500).json({ error: 'Failed to fetch status.' })
  }
}

// ─── CUSTOM DOMAIN ────────────────────────────────────────────────────────
const VERCEL_TOKEN = process.env.VERCEL_TOKEN

export const connectCustomDomain = async (req, res) => {
  try {
    const { domain } = req.body
    if (!domain?.trim()) return res.status(400).json({ error: 'Domain is required.' })

    const a = await queryOne(
      'SELECT * FROM apps WHERE id = ? AND user_id = ?',
      [req.params.id, req.user.id]
    )
    if (!a) return res.status(404).json({ error: 'App not found.' })
    if (!a.vercel_project_id) return res.status(400).json({ error: 'App has no Vercel project linked. Deploy it first.' })

    const cleanDomain = domain.trim().toLowerCase()

    const vRes = await fetch(
      `https://api.vercel.com/v10/projects/${a.vercel_project_id}/domains`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${VERCEL_TOKEN}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ name: cleanDomain }),
      }
    )
    const vData = await vRes.json()

    if (!vRes.ok) {
      return res.status(400).json({ error: vData.error?.message || 'Failed to add domain on Vercel.' })
    }

    await query(
      'UPDATE apps SET custom_domain = ?, domain_status = ?, updated_at = NOW() WHERE id = ?',
      [cleanDomain, vData.verified ? 'verified' : 'pending', req.params.id]
    )

    // vData tells us exactly what DNS record to show the user
    res.json({
      domain: cleanDomain,
      verified: !!vData.verified,
      // e.g. { type: 'CNAME', name: 'app', value: 'cname.vercel-dns.com' }
      dnsRecord: vData.verification?.[0] || {
        type: cleanDomain.split('.').length > 2 ? 'CNAME' : 'A',
        name: cleanDomain.split('.').length > 2 ? cleanDomain.split('.')[0] : '@',
        value: cleanDomain.split('.').length > 2 ? 'cname.vercel-dns.com' : '76.76.21.21',
      },
    })
  } catch (err) {
    console.error('connectCustomDomain error:', err)
    res.status(500).json({ error: 'Failed to connect domain.' })
  }
}

export const checkDomainStatus = async (req, res) => {
  try {
    const a = await queryOne(
      'SELECT * FROM apps WHERE id = ? AND user_id = ?',
      [req.params.id, req.user.id]
    )
    if (!a) return res.status(404).json({ error: 'App not found.' })
    if (!a.custom_domain) return res.status(400).json({ error: 'No domain connected yet.' })

    const vRes = await fetch(
      `https://api.vercel.com/v9/projects/${a.vercel_project_id}/domains/${a.custom_domain}`,
      { headers: { Authorization: `Bearer ${VERCEL_TOKEN}` } }
    )
    const vData = await vRes.json()
    const verified = !!vData.verified

    const newStatus = verified ? 'verified' : 'pending'
    if (newStatus !== a.domain_status) {
      await query('UPDATE apps SET domain_status = ? WHERE id = ?', [newStatus, a.id])
    }

    res.json({ domain: a.custom_domain, verified, status: newStatus })
  } catch (err) {
    console.error('checkDomainStatus error:', err)
    res.status(500).json({ error: 'Failed to check domain status.' })
  }
}

export const removeCustomDomain = async (req, res) => {
  try {
    const a = await queryOne(
      'SELECT * FROM apps WHERE id = ? AND user_id = ?',
      [req.params.id, req.user.id]
    )
    if (!a?.custom_domain) return res.status(404).json({ error: 'No domain to remove.' })

    await fetch(
      `https://api.vercel.com/v9/projects/${a.vercel_project_id}/domains/${a.custom_domain}`,
      { method: 'DELETE', headers: { Authorization: `Bearer ${VERCEL_TOKEN}` } }
    )

    await query(
      'UPDATE apps SET custom_domain = NULL, domain_status = "none" WHERE id = ?',
      [a.id]
    )
    res.json({ message: 'Domain removed.' })
  } catch (err) {
    console.error('removeCustomDomain error:', err)
    res.status(500).json({ error: 'Failed to remove domain.' })
  }
}

export const downloadApp = async (req, res) => {
  try {
    const a = await queryOne(
      `SELECT * FROM apps WHERE id = ? AND user_id = ? AND download_paid = 1 AND status = 'ready'`,
      [req.params.id, req.user.id]
    )
    if (!a) return res.status(403).json({ error: 'Please pay ₹499 to download this app.' })

    const esc = s => (s || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')

    const fn = (a.title || 'app')
      .replace(/[^a-z0-9\s]/gi, '')
      .replace(/\s+/g, '_')
      .toLowerCase()
      .slice(0, 50) || 'app'

    const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${esc(a.title)} — Zater App Files</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: system-ui, sans-serif; background: #0a0a12; color: #e0e0f0; padding: 24px; }
    h1   { font-size: 22px; color: #fff; margin-bottom: 6px; }
    .sub { font-size: 13px; color: #72727f; margin-bottom: 28px; }
    .fs  { margin-bottom: 20px; border: 1px solid #2a2a3a; border-radius: 10px; overflow: hidden; }
    .fh  { background: #1a1a2e; padding: 12px 16px; display: flex; justify-content: space-between; align-items: center; }
    .fn  { font-size: 13px; font-weight: 700; color: #a0a0ff; }
    .cb  { background: #6c63ff; color: #fff; border: none; padding: 5px 12px; border-radius: 6px; font-size: 11px; cursor: pointer; transition: background 0.2s; }
    .cb:hover { background: #574fd6; }
    pre  { padding: 16px; font-size: 12px; line-height: 1.6; overflow-x: auto; white-space: pre-wrap; color: #c8d3f5; background: #0d0d1a; max-height: 500px; overflow-y: auto; }
    .note { background: #1a1a0a; border: 1px solid #3a3a1a; border-radius: 8px; padding: 14px; font-size: 12px; color: #c8c070; line-height: 1.6; margin-bottom: 20px; }
    .toast { position: fixed; bottom: 20px; right: 20px; background: #22c55e; color: #fff; padding: 10px 18px; border-radius: 8px; font-size: 13px; display: none; z-index: 999; }
  </style>
</head>
<body>
  <h1>${esc(a.title)}</h1>
  <div class="sub">Generated by Zater AI Studio · ${new Date().toLocaleDateString()}</div>
  <div class="note">💡 Save each file: <b>App.jsx</b> → React frontend · <b>server.js</b> → Node backend · <b>schema.sql</b> → run in MySQL first</div>

  <div class="fs">
    <div class="fh">
      <span class="fn">src/App.jsx — React Frontend</span>
      <button class="cb" onclick="copyCode('fe', this)">Copy</button>
    </div>
    <pre id="fe">${esc(a.frontend)}</pre>
  </div>

  <div class="fs">
    <div class="fh">
      <span class="fn">server.js — Node.js Backend</span>
      <button class="cb" onclick="copyCode('be', this)">Copy</button>
    </div>
    <pre id="be">${esc(a.backend)}</pre>
  </div>

  <div class="fs">
    <div class="fh">
      <span class="fn">schema.sql — Database Schema</span>
      <button class="cb" onclick="copyCode('sql', this)">Copy</button>
    </div>
    <pre id="sql">${esc(a.schema_sql)}</pre>
  </div>

  <div class="fs">
    <div class="fh">
      <span class="fn">README.md — Setup Guide</span>
      <button class="cb" onclick="copyCode('rm', this)">Copy</button>
    </div>
    <pre id="rm">${esc(a.readme)}</pre>
  </div>

  <div class="toast" id="toast">✅ Copied to clipboard!</div>

  <script>
    function copyCode(id, btn) {
      const text = document.getElementById(id).innerText
      navigator.clipboard.writeText(text).then(() => {
        const t = document.getElementById('toast')
        t.style.display = 'block'
        setTimeout(() => { t.style.display = 'none' }, 2000)
      }).catch(() => { alert('Copy failed — please select and copy manually.') })
    }
  </script>
</body>
</html>`

    res.setHeader('Content-Type', 'text/html; charset=utf-8')
    res.setHeader('Content-Disposition', `attachment; filename="${fn}_app.html"`)
    res.send(html)
    console.log(`📦 [${a.id}] App downloaded`)

  } catch (err) {
    console.error('downloadApp error:', err)
    res.status(500).json({ error: 'Download failed.' })
  }
}

export const updateAppTitle = async (req, res) => {
  try {
    const { title } = req.body
    if (!title?.trim()) return res.status(400).json({ error: 'Title is required.' })

    const a = await queryOne(
      'SELECT id FROM apps WHERE id = ? AND user_id = ?',
      [req.params.id, req.user.id]
    )
    if (!a) return res.status(404).json({ error: 'App not found.' })

    await query(
      'UPDATE apps SET title = ?, updated_at = NOW() WHERE id = ?',
      [title.trim(), req.params.id]
    )
    res.json({ message: 'Title updated.' })
  } catch (err) {
    console.error('updateAppTitle error:', err)
    res.status(500).json({ error: 'Failed to update title.' })
  }
}
// controllers/appController.js (or deployController.js)

export const checkDeployStatus = async (req, res) => {
  const { id } = req.params;

  try {
    // 1. Get the app's deployment info from MySQL
    const a = await queryOne(
      'SELECT deploy_url, vercel_project_id FROM apps WHERE id = ? AND user_id = ?',
      [id, req.user.id]
    );

    if (!a || !a.vercel_project_id) {
      return res.status(404).json({ error: 'No deployment found for this app' });
    }

    // 2. Get the latest deployment for this project from Vercel
    const vercelRes = await fetch(
      `https://api.vercel.com/v6/deployments?projectId=${a.vercel_project_id}&limit=1`,
      { headers: { Authorization: `Bearer ${process.env.VERCEL_TOKEN}` } }
    );
    const vercelData = await vercelRes.json();
    const latest = vercelData.deployments?.[0];

    if (!latest) {
      return res.status(404).json({ error: 'No Vercel deployments found for this project' });
    }

    // 3. Also check if the stored deploy_url is actually serving
    let urlLive = false;
    try {
      const urlCheck = await fetch(a.deploy_url, { method: 'HEAD' });
      urlLive = urlCheck.ok;
    } catch (e) {
      urlLive = false;
    }

    return res.json({
      readyState: latest.readyState,
      urlLive,
      deployUrl: a.deploy_url,
    });
  } catch (err) {
    console.error('checkDeployStatus error:', err);
    return res.status(500).json({ error: 'Failed to check deploy status' });
  }
};
// ─── UNDEPLOY (remove deployment only, keep the app) ─────────────────────────


export const undeployApp = async (req, res) => {
  try {
    const a = await queryOne(
      'SELECT * FROM apps WHERE id = ? AND user_id = ?',
      [req.params.id, req.user.id]
    )
    if (!a) return res.status(404).json({ error: 'App not found.' })

    if (!a.deploy_url && !a.vercel_project_id && !a.render_service_id) {
      return res.status(400).json({ error: 'App is not currently deployed.' })
    }

    // 1. Remove custom domain from Vercel first (can't delete project cleanly with domains attached)
    if (a.custom_domain && a.vercel_project_id) {
      try {
        await fetch(
          `https://api.vercel.com/v9/projects/${a.vercel_project_id}/domains/${a.custom_domain}`,
          { method: 'DELETE', headers: { Authorization: `Bearer ${VERCEL_TOKEN}` } }
        )
      } catch (e) {
        console.warn(`[${a.id}] Failed to remove custom domain during undeploy:`, e.message)
      }
    }

    // 2. Delete the Vercel project (frontend)
    if (a.vercel_project_id) {
      try {
        const delRes = await fetch(
          `https://api.vercel.com/v9/projects/${a.vercel_project_id}`,
          { method: 'DELETE', headers: { Authorization: `Bearer ${VERCEL_TOKEN}` } }
        )
        if (!delRes.ok && delRes.status !== 404) {
          const errData = await delRes.json().catch(() => ({}))
          console.warn(`[${a.id}] Vercel project delete returned ${delRes.status}:`, errData.error?.message)
        }
      } catch (e) {
        console.warn(`[${a.id}] Failed to delete Vercel project during undeploy:`, e.message)
      }
    }

    // 3. Delete the Render service (backend)
    if (a.render_service_id) {
      try {
        const delRes = await fetch(
          `https://api.render.com/v1/services/${a.render_service_id}`,
          { method: 'DELETE', headers: { Authorization: `Bearer ${process.env.RENDER_API_KEY}` } }
        )
        if (!delRes.ok && delRes.status !== 404) {
          console.warn(`[${a.id}] Render service delete returned ${delRes.status}`)
        }
      } catch (e) {
        console.warn(`[${a.id}] Failed to delete Render service during undeploy:`, e.message)
      }
    }

    // 4. Drop the app's Supabase schema (data + tables)
    if (a.supabase_schema) {
      try {
       const client = new Client({
  connectionString: process.env.SUPABASE_DB_URL,
  ssl: { rejectUnauthorized: false },
})
        await client.connect()
        await client.query(`DROP SCHEMA IF EXISTS "${a.supabase_schema}" CASCADE`)
        await client.end()
      } catch (e) {
        console.warn(`[${a.id}] Failed to drop Supabase schema during undeploy:`, e.message)
      }
    }

    // 5. Clear all deployment-related columns — app record itself stays untouched
    await query(
      `UPDATE apps
          SET deploy_url = NULL,
              vercel_project_id = NULL,
              render_service_id = NULL,
              backend_url = NULL,
              supabase_schema = NULL,
              custom_domain = NULL,
              domain_status = 'none',
              updated_at = NOW()
        WHERE id = ?`,
      [a.id]
    )

    res.json({ message: 'Deployment removed. App is still saved and can be redeployed.' })
  } catch (err) {
    console.error('undeployApp error:', err)
    res.status(500).json({ error: 'Failed to remove deployment: ' + err.message })
  }
}
export const regenerateApp = async (req, res) => {
  try {
    const { prompt } = req.body
    const userId = req.user.id

    const a = await queryOne('SELECT * FROM apps WHERE id = ? AND user_id = ?', [req.params.id, userId])
    if (!a) return res.status(404).json({ error: 'App not found.' })

    const user = await queryOne('SELECT credits FROM users WHERE id = ?', [userId])
    if (!user || user.credits < APP_GEN_CREDITS) {
      return res.status(402).json({ error: 'Insufficient credits to regenerate.' })
    }

    const inProgress = await queryOne(
      `SELECT id FROM apps WHERE user_id = ? AND status = 'generating' AND id != ?`,
      [userId, req.params.id]
    )
    if (inProgress) {
      return res.status(429).json({ error: 'Another app is already generating. Please wait.' })
    }

    const p = prompt?.trim() || a.prompt

    await query(`UPDATE apps SET status='generating', current_step='Restarting generation...' WHERE id=?`, [req.params.id])

    res.json({ message: 'Regeneration started!' })

    generateApp(req.params.id, p)
      .catch(err => console.error(`[${req.params.id}] Regen error:`, err.message))

  } catch (err) {
    console.error('regenerateApp error:', err)
    res.status(500).json({ error: 'Failed to start regeneration.' })
  }
}

export const deleteApp = async (req, res) => {
  try {
    const a = await queryOne(
      'SELECT id FROM apps WHERE id = ? AND user_id = ?',
      [req.params.id, req.user.id]
    )
    if (!a) return res.status(404).json({ error: 'App not found.' })

    await query('DELETE FROM apps WHERE id = ?', [a.id])
    res.json({ message: 'App deleted successfully.' })
  } catch (err) {
    console.error('deleteApp error:', err)
    res.status(500).json({ error: 'Failed to delete app.' })
  }
}