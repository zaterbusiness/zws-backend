// utils/intentGuard.js
const APP_SIGNALS = [
  'login', 'signup', 'sign up', 'dashboard', 'crud', 'database', 'admin panel',
  'user management', 'tracker', 'management system', 'booking system',
  'inventory', 'orders', 'expense', 'task manager', 'project management',
  'schema', 'backend', 'api', 'authentication', 'role-based', 'crud operations',
  'multi-user', 'analytics dashboard'
]

const WEBSITE_SIGNALS = [
  'landing page', 'portfolio', 'restaurant website', 'business website',
  'brochure', 'menu & reservations', 'gallery', 'about us', 'contact page',
  'single page', 'showcase', 'promotional', 'informational site', 'one page site'
]

export function detectPromptType(prompt) {
  const p = prompt.toLowerCase()
  const appHits = APP_SIGNALS.filter(w => p.includes(w)).length
  const webHits = WEBSITE_SIGNALS.filter(w => p.includes(w)).length

  if (appHits === 0 && webHits === 0) return 'ambiguous'
  if (appHits > webHits) return 'app'
  if (webHits > appHits) return 'website'
  return 'ambiguous'
}