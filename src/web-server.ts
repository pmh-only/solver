import { readFile } from 'node:fs/promises'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { join } from 'node:path'
import {
  runWebAgent,
  runWebComponentInteraction,
  runWebInteraction,
  loadWebConversation,
  clearWebConversation,
  createWebSession,
  loadWebSessionState
} from './commands/gpt.js'
import { handleGoogleCalendarCallback } from './google-calendar-auth.js'
import { consumeStoredRateLimit, hasStoredValue } from './helpers/kv-store.js'
import { readHostedHtml, readSharedHtml } from './hosted-page.js'
import { loadModelsResponse } from './model-catalog.js'
import { handleSpotifyCallback } from './spotify-auth.js'
import { loadSystemPromptSetting, resetSystemPrompt, updateSystemPrompt } from './system-prompt.js'
import {
  beginOidcLogin,
  clearSessionCookie,
  completeOidcLogin,
  getWebSession,
  initializeWebAuth,
  loadOidcSettings,
  logoutUrl,
  publicOidcSettings,
  requireCsrf,
  saveOidcSettings
} from './web-auth.js'
import { WEB_CSS, WEB_HTML, WEB_JS } from './web-ui.js'

const DEFAULT_PORT = 3000
const DEFAULT_HOST = '0.0.0.0'
const MAX_BODY_BYTES = 64 * 1024

function securityHeaders(contentSecurityPolicy = true): Record<string, string> {
  return {
    'Cache-Control': 'no-store',
    ...(contentSecurityPolicy
      ? {
          'Content-Security-Policy':
            "default-src 'self'; connect-src 'self'; font-src 'self'; img-src 'self' https: data:; style-src 'self'; script-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'"
        }
      : {}),
    'Referrer-Policy': 'no-referrer',
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=()'
  }
}

function send(
  response: ServerResponse,
  statusCode: number,
  contentType: string,
  body: string,
  headOnly = false,
  contentSecurityPolicy = true
): void {
  response.writeHead(statusCode, {
    ...securityHeaders(contentSecurityPolicy),
    'Content-Type': contentType,
    'Content-Length': Buffer.byteLength(body)
  })
  response.end(headOnly ? undefined : body)
}

function sendJson(response: ServerResponse, statusCode: number, value: unknown): void {
  send(response, statusCode, 'application/json; charset=utf-8', `${JSON.stringify(value)}\n`)
}

function sendSandboxedHtml(response: ServerResponse, html: string, headOnly: boolean): void {
  response.writeHead(200, {
    ...securityHeaders(false),
    'Content-Security-Policy':
      "sandbox allow-scripts allow-forms allow-modals allow-popups; default-src * data: blob:; script-src * data: blob: 'unsafe-inline' 'unsafe-eval'; style-src * data: blob: 'unsafe-inline'; connect-src *; frame-ancestors 'none'",
    'Content-Type': 'text/html; charset=utf-8',
    'Content-Length': Buffer.byteLength(html)
  })
  response.end(headOnly ? undefined : html)
}

async function readJson(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    size += buffer.length
    if (size > MAX_BODY_BYTES) throw new Error('Request body is too large')
    chunks.push(buffer)
  }
  const contentType = request.headers['content-type'] ?? ''
  if (!contentType.toLowerCase().startsWith('application/json')) {
    throw new Error('Content-Type must be application/json')
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}

function remoteId(request: IncomingMessage): string {
  if (process.env.WEB_TRUST_PROXY === 'true') {
    const forwarded = request.headers['x-forwarded-for']
    const first = (Array.isArray(forwarded) ? forwarded[0] : forwarded)?.split(',')[0]?.trim()
    if (first) return first
  }
  return request.socket.remoteAddress ?? 'unknown'
}

function authenticated(request: IncomingMessage, response: ServerResponse) {
  const session = getWebSession(request)
  if (!session) sendJson(response, 401, { error: 'Authentication required' })
  return session
}

function mutationAllowed(request: IncomingMessage, response: ServerResponse) {
  const session = authenticated(request, response)
  if (!session) return null
  if (!requireCsrf(request, session)) {
    sendJson(response, 403, { error: 'Invalid CSRF token' })
    return null
  }
  return session
}

function safeError(error: unknown): string {
  if (!(error instanceof Error)) return 'Request failed'
  if (error.name === 'ZodError' || error instanceof SyntaxError) return 'Invalid request data'
  const safe = [
    'Prompt must',
    'Session name',
    'Invalid reasoning effort',
    'Token limit',
    'Model must',
    'OIDC redirect URI',
    'OIDC scopes',
    'Initial OIDC setup',
    'System prompt must',
    'Invalid component interaction',
    'Component interaction expired',
    'Only the user who sent',
    'This component requires',
    'Content-Type',
    'Request body',
    'Invalid interaction',
    'Interaction expired',
    'Interaction already',
    'Only the user',
    'This interaction belongs',
    'Invalid modal',
    'Modal field',
    'Unsupported modal'
  ]
  return safe.some((prefix) => error.message.startsWith(prefix)) ? error.message : 'Request failed'
}

async function handleApiRequest(
  request: IncomingMessage,
  response: ServerResponse,
  url: URL
): Promise<boolean> {
  const method = request.method ?? 'GET'
  if (url.pathname === '/api/session' && method === 'GET') {
    const session = getWebSession(request)
    let settings = null
    try {
      settings = loadOidcSettings()
    } catch {
      // Invalid configuration is visible only as disabled until an administrator replaces it.
    }
    sendJson(response, 200, {
      user: session?.user ?? null,
      csrfToken: session?.csrfToken ?? null,
      oidcSetupRequired: !hasStoredValue('web-oidc-settings'),
      oidcEnabled: settings?.enabled ?? false,
      automaticLogin: settings?.automaticLogin ?? false
    })
    return true
  }
  if (url.pathname === '/api/admin/oidc' && method === 'GET') {
    if (hasStoredValue('web-oidc-settings')) {
      const session = authenticated(request, response)
      if (!session) return true
    }
    sendJson(response, 200, publicOidcSettings())
    return true
  }
  if (url.pathname === '/api/admin/oidc' && method === 'PUT') {
    const initialSetup = !hasStoredValue('web-oidc-settings')
    if (initialSetup) {
      if (!consumeStoredRateLimit(`web-rate:oidc-setup:${remoteId(request)}`, 5, 15 * 60_000)) {
        sendJson(response, 429, { error: 'Too many setup attempts' })
        return true
      }
    } else {
      const session = mutationAllowed(request, response)
      if (!session) return true
    }
    const body = await readJson(request)
    if (initialSetup && hasStoredValue('web-oidc-settings')) {
      sendJson(response, 409, { error: 'OIDC setup was completed by another request' })
      return true
    }
    if (initialSetup && (body as Record<string, unknown>).enabled !== true) {
      throw new Error('Initial OIDC setup must enable login')
    }
    sendJson(response, 200, saveOidcSettings(body))
    return true
  }
  if (url.pathname === '/api/admin/system-prompt' && method === 'GET') {
    if (!authenticated(request, response)) return true
    sendJson(response, 200, loadSystemPromptSetting())
    return true
  }
  if (url.pathname === '/api/admin/system-prompt' && method === 'PUT') {
    const session = mutationAllowed(request, response)
    if (!session) return true
    sendJson(response, 200, updateSystemPrompt(await readJson(request), session.user.id))
    return true
  }
  if (url.pathname === '/api/admin/system-prompt/reset' && method === 'POST') {
    const session = mutationAllowed(request, response)
    if (!session) return true
    sendJson(response, 200, resetSystemPrompt(session.user.id))
    return true
  }
  if (url.pathname === '/api/chat/history' && method === 'GET') {
    const session = authenticated(request, response)
    if (!session) return true
    if (!session.user.allowed) {
      sendJson(response, 403, { error: 'Web assistant access is not allowed for this identity' })
      return true
    }
    sendJson(
      response,
      200,
      loadWebConversation(session.user.id, url.searchParams.get('session') || 'default')
    )
    return true
  }
  if (url.pathname === '/api/chat/sessions' && method === 'GET') {
    const session = authenticated(request, response)
    if (!session) return true
    if (!session.user.allowed) {
      sendJson(response, 403, { error: 'Web assistant access is not allowed for this identity' })
      return true
    }
    sendJson(
      response,
      200,
      loadWebSessionState(session.user.id, url.searchParams.get('session') || 'default')
    )
    return true
  }
  if (url.pathname === '/api/chat/sessions' && method === 'POST') {
    const session = mutationAllowed(request, response)
    if (!session) return true
    if (!session.user.allowed) {
      sendJson(response, 403, { error: 'Web assistant access is not allowed for this identity' })
      return true
    }
    const body = (await readJson(request)) as { sessionName?: unknown }
    sendJson(
      response,
      201,
      createWebSession(
        session.user.id,
        typeof body.sessionName === 'string' ? body.sessionName : ''
      )
    )
    return true
  }
  if (url.pathname === '/api/chat/clear' && method === 'POST') {
    const session = mutationAllowed(request, response)
    if (!session) return true
    if (!session.user.allowed) {
      sendJson(response, 403, { error: 'Web assistant access is not allowed for this identity' })
      return true
    }
    const body = (await readJson(request)) as { sessionName?: unknown }
    const sessionName = typeof body.sessionName === 'string' ? body.sessionName : 'default'
    await clearWebConversation(session.user.id, sessionName)
    sendJson(response, 200, { ok: true })
    return true
  }
  if (url.pathname === '/api/chat/interaction' && method === 'POST') {
    const session = mutationAllowed(request, response)
    if (!session) return true
    if (!session.user.allowed) {
      sendJson(response, 403, { error: 'Web assistant access is not allowed for this identity' })
      return true
    }
    if (!consumeStoredRateLimit(`web-rate:interaction:${session.user.id}`, 40, 60_000)) {
      sendJson(response, 429, { error: 'Rate limit exceeded' })
      return true
    }
    const body = (await readJson(request)) as Record<string, unknown>
    response.writeHead(200, {
      ...securityHeaders(),
      'Content-Type': 'application/x-ndjson; charset=utf-8',
      'X-Accel-Buffering': 'no',
      Connection: 'keep-alive'
    })
    const write = (value: unknown) => {
      if (!response.destroyed) response.write(`${JSON.stringify(value)}\n`)
    }
    const controller = new AbortController()
    response.once('close', () => {
      if (!response.writableEnded) controller.abort()
    })
    try {
      const result = await runWebInteraction(
        {
          userId: session.user.id,
          customId: typeof body.customId === 'string' ? body.customId : '',
          values: body.values as string[] | undefined,
          fields: body.fields as never
        },
        async (payload) => write({ payload }),
        controller.signal
      )
      if ('modal' in result) write({ modal: result.modal })
    } catch (error) {
      write({ error: safeError(error) })
    } finally {
      response.end()
    }
    return true
  }
  if (url.pathname === '/api/chat' && method === 'POST') {
    const session = mutationAllowed(request, response)
    if (!session) return true
    if (!session.user.allowed) {
      sendJson(response, 403, { error: 'Web assistant access is not allowed for this identity' })
      return true
    }
    if (!consumeStoredRateLimit(`web-rate:chat:${session.user.id}`, 20, 60_000)) {
      sendJson(response, 429, { error: 'Rate limit exceeded' })
      return true
    }
    const body = (await readJson(request)) as Record<string, unknown>
    response.writeHead(200, {
      ...securityHeaders(),
      'Content-Type': 'application/x-ndjson; charset=utf-8',
      'X-Accel-Buffering': 'no',
      Connection: 'keep-alive'
    })
    const write = (value: unknown) => {
      if (!response.destroyed) response.write(`${JSON.stringify(value)}\n`)
    }
    const controller = new AbortController()
    response.once('close', () => {
      if (!response.writableEnded) controller.abort()
    })
    try {
      await runWebAgent(
        {
          userId: session.user.id,
          prompt: typeof body.prompt === 'string' ? body.prompt : '',
          sessionName: typeof body.sessionName === 'string' ? body.sessionName : undefined,
          model: typeof body.model === 'string' ? body.model : undefined,
          effort: typeof body.effort === 'string' ? body.effort : undefined,
          maxTokens: typeof body.maxTokens === 'number' ? body.maxTokens : undefined
        },
        async (payload) => write({ payload }),
        controller.signal
      )
    } catch (error) {
      write({ error: safeError(error) })
    } finally {
      response.end()
    }
    return true
  }
  if (url.pathname === '/api/interactions/components' && method === 'POST') {
    const session = mutationAllowed(request, response)
    if (!session) return true
    if (!session.user.allowed) {
      sendJson(response, 403, { error: 'Web assistant access is not allowed for this identity' })
      return true
    }
    if (!consumeStoredRateLimit(`web-rate:component:${session.user.id}`, 60, 60_000)) {
      sendJson(response, 429, { error: 'Rate limit exceeded' })
      return true
    }
    const body = (await readJson(request)) as Record<string, unknown>
    const customId = typeof body.customId === 'string' ? body.customId : ''
    const values = Array.isArray(body.values)
      ? body.values.filter((value): value is string => typeof value === 'string')
      : undefined
    response.writeHead(200, {
      ...securityHeaders(),
      'Content-Type': 'application/x-ndjson; charset=utf-8',
      'X-Accel-Buffering': 'no',
      Connection: 'keep-alive'
    })
    const write = (value: unknown) => {
      if (!response.destroyed) response.write(`${JSON.stringify(value)}\n`)
    }
    const controller = new AbortController()
    response.once('close', () => {
      if (!response.writableEnded) controller.abort()
    })
    try {
      await runWebComponentInteraction(
        { userId: session.user.id, customId, values },
        async (payload) => write({ payload }),
        controller.signal
      )
    } catch (error) {
      write({ error: safeError(error) })
    } finally {
      response.end()
    }
    return true
  }
  return false
}

export async function handleWebRequest(
  request: IncomingMessage,
  response: ServerResponse
): Promise<void> {
  const method = request.method ?? 'GET'
  let url: URL
  try {
    url = new URL(request.url ?? '/', 'http://web.local')
  } catch {
    send(response, 400, 'text/plain; charset=utf-8', 'Bad Request\n', method === 'HEAD')
    return
  }

  try {
    if (url.pathname.startsWith('/api/') && (await handleApiRequest(request, response, url))) return
    if (url.pathname === '/auth/login' && method === 'GET') {
      if (!consumeStoredRateLimit(`web-rate:oidc:${remoteId(request)}`, 20, 15 * 60_000)) {
        sendJson(response, 429, { error: 'Too many login attempts' })
        return
      }
      const target = await beginOidcLogin(
        request,
        response,
        url.searchParams.get('returnTo') || '/'
      )
      response.writeHead(302, { ...securityHeaders(), Location: target.href })
      response.end()
      return
    }
    if (url.pathname === '/auth/callback' && method === 'GET') {
      const settings = loadOidcSettings()
      if (!settings) throw new Error('OIDC is not configured')
      const callback = new URL(settings.redirectUri)
      callback.search = url.search
      const returnTo = await completeOidcLogin(request, response, callback)
      response.writeHead(302, { ...securityHeaders(), Location: returnTo })
      response.end()
      return
    }
    if (url.pathname === '/api/auth/logout' && method === 'POST') {
      const session = mutationAllowed(request, response)
      if (!session) return
      const target = await logoutUrl(request)
      clearSessionCookie(request, response)
      sendJson(response, 200, { location: target?.href ?? '/' })
      return
    }
    if (method !== 'GET' && method !== 'HEAD') {
      response.setHeader('Allow', 'GET, HEAD')
      send(response, 405, 'text/plain; charset=utf-8', 'Method Not Allowed\n')
      return
    }
    const head = method === 'HEAD'
    if (url.pathname === '/') {
      send(response, 200, 'text/html; charset=utf-8', WEB_HTML, head)
      return
    }
    if (url.pathname === '/app.css') {
      send(response, 200, 'text/css; charset=utf-8', WEB_CSS, head)
      return
    }
    if (url.pathname === '/app.js') {
      send(response, 200, 'text/javascript; charset=utf-8', WEB_JS, head)
      return
    }
    if (url.pathname === '/favicon.ico') {
      response.writeHead(204, securityHeaders())
      response.end()
      return
    }
    if (/^\/fonts\/gg-sans-(400|700)\.woff2$/.test(url.pathname)) {
      const body = await readFile(join(process.cwd(), 'assets', url.pathname))
      response.writeHead(200, {
        ...securityHeaders(),
        'Cache-Control': 'public, max-age=31536000, immutable',
        'Content-Type': 'font/woff2',
        'Content-Length': body.length
      })
      response.end(head ? undefined : body)
      return
    }
    if (url.pathname === '/hosted') {
      const hosted = await readHostedHtml()
      if (!hosted)
        send(response, 404, 'text/plain; charset=utf-8', 'No page has been published.\n', head)
      else sendSandboxedHtml(response, hosted, head)
      return
    }
    const sharedMatch = url.pathname.match(/^\/shared\/([^/]+)$/)
    if (sharedMatch) {
      const shared = await readSharedHtml(sharedMatch[1]!)
      if (!shared) send(response, 404, 'text/plain; charset=utf-8', 'Not Found\n', head)
      else sendSandboxedHtml(response, shared, head)
      return
    }
    if (url.pathname === '/healthz') {
      send(response, 200, 'text/plain; charset=utf-8', 'ok\n', head)
      return
    }
    if (url.pathname === '/models') {
      try {
        sendJson(response, 200, await loadModelsResponse())
      } catch (error) {
        console.error('could not load models', error)
        sendJson(response, 502, { error: 'Could not load models' })
      }
      return
    }
    if (url.pathname === '/mcp/spotify/callback' && method === 'GET') {
      const result = await handleSpotifyCallback(url)
      send(response, result.status, 'text/plain; charset=utf-8', `${result.body}\n`)
      return
    }
    if (url.pathname === '/mcp/google-calendar/callback' && method === 'GET') {
      const result = await handleGoogleCalendarCallback(url)
      send(response, result.status, 'text/plain; charset=utf-8', `${result.body}\n`)
      return
    }
    send(response, 404, 'text/plain; charset=utf-8', 'Not Found\n', head)
  } catch (error) {
    console.error('web request failed', error instanceof Error ? error.message : error)
    if (!response.headersSent) sendJson(response, 400, { error: safeError(error) })
    else response.end()
  }
}

export function createWebServer(): Server {
  const server = createServer((request, response) => void handleWebRequest(request, response))
  server.requestTimeout = 30_000
  server.headersTimeout = 10_000
  server.keepAliveTimeout = 5_000
  server.maxHeadersCount = 100
  server.maxRequestsPerSocket = 100
  return server
}

function parsePort(value: string | undefined): number {
  if (value === undefined || value === '') return DEFAULT_PORT
  const port = Number(value)
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error('PORT must be an integer between 1 and 65535')
  }
  return port
}

export async function startWebServer(
  options: { host?: string; port?: number } = {}
): Promise<Server> {
  const host = options.host ?? process.env.WEB_HOST ?? DEFAULT_HOST
  const port = options.port ?? parsePort(process.env.PORT)
  initializeWebAuth()
  const server = createWebServer()
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => {
      server.off('listening', onListening)
      reject(error)
    }
    const onListening = () => {
      server.off('error', onError)
      resolve()
    }
    server.once('error', onError)
    server.once('listening', onListening)
    server.listen(port, host)
  })
  return server
}

export async function closeWebServer(server: Server): Promise<void> {
  if (!server.listening) return
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve()))
  )
}
