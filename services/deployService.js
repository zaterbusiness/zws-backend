import { Octokit } from '@octokit/rest'
import pkg from 'pg'
const { Client } = pkg

const octokit = new Octokit({ auth: process.env.GITHUB_TOKEN })

// --- Retry helper ---------------------------------------------------------
// Retries a GitHub API call on transient network errors (connect timeouts,
// DNS hiccups, etc). Does NOT retry on real API errors like 404/401/422 —
// those are passed straight to the caller so existing "err.status === 404"
// checks still work correctly.
async function withGithubRetry(fn, { retries = 6, baseDelayMs = 3000, maxDelayMs = 20000, label = 'github-call' } = {}) {
  let lastErr
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      return await fn()
    } catch (err) {
      lastErr = err

      const isTransient =
        err.code === 'UND_ERR_CONNECT_TIMEOUT' ||
        err.cause?.code === 'UND_ERR_CONNECT_TIMEOUT' ||
        err.cause?.cause?.code === 'UND_ERR_CONNECT_TIMEOUT' ||
        err.code === 'ETIMEDOUT' ||
        err.code === 'ECONNRESET' ||
        err.code === 'ENOTFOUND' ||
        err.message?.includes('fetch failed') ||
        err.status === undefined // octokit sets status on real HTTP responses; undefined usually means the request never completed

      if (!isTransient || attempt === retries) {
        throw err
      }

      // Exponential backoff with jitter, capped at maxDelayMs.
      // Indian ISP routes to GitHub's fronting IPs can hang for 30-60s at a
      // stretch (intermittent packet loss, not a hard block), so we need a
      // longer total retry window than a typical transient-error retry.
      const exponential = Math.min(baseDelayMs * 2 ** (attempt - 1), maxDelayMs)
      const jitter = Math.random() * 1000
      const delay = Math.round(exponential + jitter)

      console.warn(
        `[${label}] transient network error (attempt ${attempt}/${retries}), retrying in ${delay}ms:`,
        err.message
      )
      await new Promise((resolve) => setTimeout(resolve, delay))
    }
  }
  throw lastErr
}

// 1. Push generated backend files to a fresh GitHub repo (Render needs a repo to deploy from)
export async function pushBackendToGithub(appId, files) {
  const repoName = `zws-app-${appId.slice(0, 8)}`
  const owner = process.env.GITHUB_USERNAME

  // Check if the repo already exists (e.g. from a prior failed deploy attempt)
  let repoExists = true
  try {
    await withGithubRetry(() => octokit.repos.get({ owner, repo: repoName }), {
      label: 'repos.get',
    })
  } catch (err) {
    if (err.status === 404) repoExists = false
    else throw err
  }

  if (!repoExists) {
    await withGithubRetry(
      () => octokit.repos.createForAuthenticatedUser({ name: repoName, private: true, auto_init: true }),
      { label: 'repos.create' }
    )
  }

  for (const [path, content] of Object.entries(files)) {
    // Need the current file SHA to update an existing file — createOrUpdateFileContents
    // requires it, otherwise it assumes you're creating a brand new file
    let sha
    try {
      const { data } = await withGithubRetry(
        () => octokit.repos.getContent({ owner, repo: repoName, path }),
        { label: `repos.getContent(${path})` }
      )
      sha = data.sha
    } catch (err) {
      if (err.status !== 404) throw err
      // file doesn't exist yet — no sha needed, will be created fresh
    }

    await withGithubRetry(
      () =>
        octokit.repos.createOrUpdateFileContents({
          owner, repo: repoName, path,
          message: `Add ${path}`,
          content: Buffer.from(content).toString('base64'),
          ...(sha ? { sha } : {}),
        }),
      { label: `repos.createOrUpdateFileContents(${path})` }
    )
  }
  return { owner, repoName }
}

// 2. Create a Render web service pointing at that repo
// Fetch the Render account/workspace ID tied to your API key (required by /v1/services)
async function getRenderOwnerId() {
  const res = await fetch('https://api.render.com/v1/owners', {
    headers: { Authorization: `Bearer ${process.env.RENDER_API_KEY}` },
  })
  const data = await res.json()
  if (!res.ok || !data?.[0]?.owner?.id) {
    throw new Error('Could not fetch Render owner ID — check RENDER_API_KEY')
  }
  return data[0].owner.id
}

export async function deployBackendToRender(appId, owner, repoName) {
  const ownerId = await getRenderOwnerId()

  const res = await fetch('https://api.render.com/v1/services', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.RENDER_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      type: 'web_service',
      name: `zws-${appId.slice(0, 8)}`,
      ownerId,
      repo: `https://github.com/${owner}/${repoName}`,
      branch: 'main',
      serviceDetails: {
        env: 'node',
        envSpecificDetails: {
          buildCommand: 'npm install',
          startCommand: 'node server.js',
        },
      },
      envVars: [
        { key: 'SUPABASE_URL', value: process.env.SUPABASE_URL },
        { key: 'SUPABASE_KEY', value: process.env.SUPABASE_KEY },
      ],
    }),
  })
  const data = await res.json()
  if (!res.ok) {
    // Render's error responses are often an array of { field, message } or a
    // single { message }; surface whichever shape comes back so failures are
    // actually readable instead of "undefined".
    const renderMsg = Array.isArray(data)
      ? data.map((e) => e.message || JSON.stringify(e)).join('; ')
      : data.message || JSON.stringify(data)
    throw new Error(renderMsg || 'Render deploy failed')
  }
  return {
    serviceId: data.service.id,
    url: `https://${data.service.serviceDetails?.url || data.service.name + '.onrender.com'}`,
  }
}

// 3. Run the generated schema (must be Postgres syntax now) into its own Supabase schema
function sanitizeMysqlToPostgresish(sql) {
  return sql
    .replace(/CREATE\s+DATABASE[^;]*;/gi, '')   // remove CREATE DATABASE lines
    .replace(/USE\s+\w+\s*;/gi, '')             // remove USE lines
    .replace(/`/g, '"')                          // backticks -> double quotes
    .replace(/AUTO_INCREMENT/gi, '')             // strip (SERIAL/UUID should replace this instead — see note below)
    .replace(/ENGINE\s*=\s*\w+/gi, '')
    .replace(/TINYINT\(1\)/gi, 'BOOLEAN')
    .trim()
}

export async function provisionSupabaseSchema(appId, schemaSql) {
  const schemaName = `app_${appId.replace(/-/g, '_').slice(0, 16)}`
  const client = new Client({
    connectionString: process.env.SUPABASE_DB_URL,
    ssl: { rejectUnauthorized: false },
  })
  await client.connect()
  try {
    // Drop first so redeploys don't collide with tables from a prior attempt
    await client.query(`DROP SCHEMA IF EXISTS "${schemaName}" CASCADE`)
    await client.query(`CREATE SCHEMA "${schemaName}"`)
    await client.query(`SET search_path TO "${schemaName}"`)

    const looksLikeMysql = /AUTO_INCREMENT|ENUM\(|TINYINT\(1\)|CREATE\s+DATABASE|^\s*USE\s/i.test(schemaSql)
    if (looksLikeMysql) {
      throw new Error(
        'This app was generated with MySQL-syntax schema and cannot deploy to Postgres/Supabase. Please regenerate the app first (POST /apps/:id/regenerate).'
      )
    }

    await client.query(schemaSql)
  } finally {
    await client.end()
  }
  return schemaName
}
