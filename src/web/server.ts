import { readFile } from 'node:fs/promises'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { join } from 'node:path'
import { performance } from 'node:perf_hooks'
import { handleGoogleCalendarCallback } from '../integrations/google-calendar/auth.js'
import { consumeStoredRateLimit } from '../shared/storage/kv-store.js'
import { readHostedHtml, readSharedHtml } from './hosted-page.js'
import { loadModelsResponse } from '../integrations/openai/models.js'
import { handleSpotifyCallback } from '../integrations/spotify/auth.js'
import {
  beginOidcLogin,
  clearSessionCookie,
  completeOidcLogin,
  initializeWebAuth,
  loadOidcSettings,
  logoutUrl
} from './auth/session.js'
import {
  WEB_CSS,
  WEB_HTML,
  WEB_JS,
  WEB_MARKDOWN_JS,
  WEB_STREAM_JS,
  PERSONAS_HTML,
  PERSONAS_JS,
  PERSONAS_CSS,
  SEARCH_HTML,
  SEARCH_CSS,
  SEARCH_JS
} from './ui.js'
import { mutationAllowed, remoteId, safeError, securityHeaders, send, sendJson } from './http.js'
import { handleChatApi } from './routes/chat.js'
import { handleCommunityApi } from './routes/community.js'
import { handleSettingsApi } from './routes/settings.js'

const DEFAULT_PORT = 3000
const DEFAULT_HOST = '0.0.0.0'
const assets: Record<string, [string, string]> = {
  '/': ['text/html; charset=utf-8', WEB_HTML],
  '/app.css': ['text/css; charset=utf-8', WEB_CSS],
  '/app.js': ['text/javascript; charset=utf-8', WEB_JS],
  '/markdown.js': ['text/javascript; charset=utf-8', WEB_MARKDOWN_JS],
  '/stream.js': ['text/javascript; charset=utf-8', WEB_STREAM_JS],
  '/search': ['text/html; charset=utf-8', SEARCH_HTML],
  '/search.js': ['text/javascript; charset=utf-8', SEARCH_JS],
  '/search.css': ['text/css; charset=utf-8', SEARCH_CSS],
  '/personas': ['text/html; charset=utf-8', PERSONAS_HTML],
  '/personas.js': ['text/javascript; charset=utf-8', PERSONAS_JS],
  '/personas.css': ['text/css; charset=utf-8', PERSONAS_CSS]
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

export async function handleWebRequest(
  request: IncomingMessage,
  response: ServerResponse
): Promise<void> {
  const requestStartedAt = performance.now()
  const method = request.method ?? 'GET'
  let url: URL
  try {
    url = new URL(request.url ?? '/', 'http://web.local')
  } catch {
    send(response, 400, 'text/plain; charset=utf-8', 'Bad Request\n', method === 'HEAD')
    return
  }
  try {
    if (url.pathname.startsWith('/api/')) {
      if (await handleCommunityApi(request, response, url)) return
      if (await handleSettingsApi(request, response, url)) return
      if (await handleChatApi(request, response, url, requestStartedAt)) return
    }
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
      if (!mutationAllowed(request, response, 'assistant')) return
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
    const asset = assets[url.pathname]
    if (asset) {
      send(response, 200, asset[0], asset[1], head)
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
  if (!Number.isInteger(port) || port < 1 || port > 65_535)
    throw new Error('PORT must be an integer between 1 and 65535')
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
