import type { IncomingMessage, ServerResponse } from 'node:http'
import { getWebSession, requireCsrf } from './web-auth.js'

const MAX_BODY_BYTES = 64 * 1024

export function securityHeaders(contentSecurityPolicy = true): Record<string, string> {
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

export function send(
  response: ServerResponse,
  statusCode: number,
  contentType: string,
  body: string,
  headOnly = false
): void {
  response.writeHead(statusCode, {
    ...securityHeaders(),
    'Content-Type': contentType,
    'Content-Length': Buffer.byteLength(body)
  })
  response.end(headOnly ? undefined : body)
}

export function sendJson(response: ServerResponse, statusCode: number, value: unknown): void {
  send(response, statusCode, 'application/json; charset=utf-8', `${JSON.stringify(value)}\n`)
}

export async function readJson(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    size += buffer.length
    if (size > MAX_BODY_BYTES) throw new Error('Request body is too large')
    chunks.push(buffer)
  }
  const contentType = request.headers['content-type'] ?? ''
  if (!contentType.toLowerCase().startsWith('application/json'))
    throw new Error('Content-Type must be application/json')
  return JSON.parse((Buffer.concat(chunks) as Buffer).toString('utf8'))
}

export function remoteId(request: IncomingMessage): string {
  if (process.env.WEB_TRUST_PROXY === 'true') {
    const forwarded = request.headers['x-forwarded-for']
    const first = (Array.isArray(forwarded) ? forwarded[0] : forwarded)?.split(',')[0]?.trim()
    if (first) return first
  }
  return request.socket.remoteAddress ?? 'unknown'
}

export type WebAccess = 'assistant' | 'admin' | 'discord'

export function authenticated(
  request: IncomingMessage,
  response: ServerResponse,
  access: WebAccess
) {
  const session = getWebSession(request)
  if (!session) {
    sendJson(response, 401, {
      error: access === 'discord' ? '로그인이 필요합니다.' : 'Authentication required'
    })
    return null
  }
  if (access === 'discord') {
    if (!session.user.discordId || !/^\d{17,20}$/.test(session.user.discordId)) {
      sendJson(response, 403, { error: 'Discord 계정이 연결된 OIDC 로그인으로 접속해 주세요.' })
      return null
    }
  } else {
    if (!session.user.allowed) {
      sendJson(response, 403, { error: 'Web assistant access is not allowed for this identity' })
      return null
    }
    if (access === 'admin' && !session.user.admin) {
      sendJson(response, 403, { error: 'Administrator access required' })
      return null
    }
  }
  return session
}

export function mutationAllowed(
  request: IncomingMessage,
  response: ServerResponse,
  access: WebAccess
) {
  const session = authenticated(request, response, access)
  if (!session) return null
  if (!requireCsrf(request, session)) {
    sendJson(response, 403, { error: 'Invalid CSRF token' })
    return null
  }
  return session
}

export function safeError(error: unknown): string {
  if (!(error instanceof Error)) return 'Request failed'
  if (error.name === 'ZodError' || error instanceof SyntaxError) return 'Invalid request data'
  const safe = [
    '페르소나에는',
    'Prompt must',
    'Session name',
    'Invalid reasoning effort',
    'Token limit',
    'Model must',
    'OIDC redirect URI',
    'OIDC scopes',
    'Initial OIDC setup',
    'System prompt must',
    'Session system prompt must',
    'OpenAI endpoint must',
    'OpenAI token must',
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

type StreamWriter = (value: unknown) => void

export async function streamJson(
  response: ServerResponse,
  disconnect: 'abort' | 'continue',
  run: (write: StreamWriter, signal: AbortSignal) => Promise<void>,
  onError: (error: unknown, write: StreamWriter) => void = (error, write) =>
    write({ error: safeError(error) })
): Promise<void> {
  response.writeHead(200, {
    ...securityHeaders(),
    'Content-Type': 'application/x-ndjson; charset=utf-8',
    'X-Accel-Buffering': 'no',
    Connection: 'keep-alive'
  })
  const write: StreamWriter = (value) => {
    if (!response.destroyed) response.write(`${JSON.stringify(value)}\n`)
  }
  const controller = new AbortController()
  const close = () => {
    if (!response.writableEnded && disconnect === 'abort') controller.abort()
  }
  response.once('close', close)
  try {
    await run(write, controller.signal)
  } catch (error) {
    onError(error, write)
  } finally {
    response.off('close', close)
    response.end()
  }
}
