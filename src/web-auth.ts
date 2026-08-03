import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  timingSafeEqual
} from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import * as oidc from 'openid-client'
import { z } from 'zod'
import { getStoredValue, setStoredValue } from './helpers/kv-store.js'

const SETTINGS_KEY = 'web-oidc-settings'
const SESSION_TTL_MS = 12 * 60 * 60 * 1000
const OIDC_FLOW_TTL_MS = 10 * 60 * 1000
const SESSION_COOKIE = 'solver_web_session'
const FLOW_COOKIE = 'solver_oidc_state'

const settingsSchema = z.object({
  enabled: z.boolean(),
  issuerUrl: z.string().url().max(2048),
  clientId: z.string().min(1).max(512),
  clientSecret: z.string().min(1).max(4096),
  redirectUri: z.string().url().max(2048),
  scopes: z.string().min(1).max(1024),
  automaticLogin: z.boolean(),
  postLogoutRedirectUri: z.string().url().max(2048).or(z.literal('')),
  allowedSubjects: z.string().max(8192),
  adminSubjects: z.string().max(8192)
})

export type OidcSettings = z.infer<typeof settingsSchema>
export type PublicOidcSettings = Omit<OidcSettings, 'clientSecret'> & {
  hasClientSecret: boolean
}

export interface WebUser {
  id: string
  subject: string
  name: string
  email?: string
  admin: boolean
  allowed: boolean
  bootstrap: boolean
}

interface WebSession {
  user: WebUser
  csrfToken: string
  expiresAt: number
  idToken?: string
}

interface OidcFlow {
  state: string
  nonce: string
  codeVerifier: string
  returnTo: string
  expiresAt: number
}

const sessions = new Map<string, WebSession>()
const flows = new Map<string, OidcFlow>()

function encryptionKey(): Buffer {
  const secret = process.env.WEB_SESSION_SECRET?.trim()
  if (!secret || secret.length < 32) {
    throw new Error('WEB_SESSION_SECRET must contain at least 32 characters')
  }
  return createHash('sha256').update(secret).digest()
}

function encrypt(value: string): string {
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', encryptionKey(), iv)
  const ciphertext = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()])
  return [iv, cipher.getAuthTag(), ciphertext].map((part) => part.toString('base64url')).join('.')
}

function decrypt(value: string): string {
  const [iv, tag, ciphertext] = value.split('.').map((part) => Buffer.from(part ?? '', 'base64url'))
  if (!iv || !tag || !ciphertext || iv.length !== 12 || tag.length !== 16) {
    throw new Error('Invalid encrypted OIDC settings')
  }
  const decipher = createDecipheriv('aes-256-gcm', encryptionKey(), iv)
  decipher.setAuthTag(tag)
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8')
}

export function loadOidcSettings(): OidcSettings | null {
  const stored = getStoredValue(SETTINGS_KEY)
  if (!stored) return null
  return settingsSchema.parse(JSON.parse(decrypt(stored)))
}

export function publicOidcSettings(): PublicOidcSettings | null {
  const settings = loadOidcSettings()
  if (!settings) return null
  return {
    enabled: settings.enabled,
    issuerUrl: settings.issuerUrl,
    clientId: settings.clientId,
    redirectUri: settings.redirectUri,
    scopes: settings.scopes,
    automaticLogin: settings.automaticLogin,
    postLogoutRedirectUri: settings.postLogoutRedirectUri,
    allowedSubjects: settings.allowedSubjects,
    adminSubjects: settings.adminSubjects,
    hasClientSecret: true
  }
}

export function saveOidcSettings(input: unknown): PublicOidcSettings {
  const current = loadOidcSettings()
  const candidate = input as Record<string, unknown>
  const clientSecret =
    typeof candidate.clientSecret === 'string' && candidate.clientSecret
      ? candidate.clientSecret
      : current?.clientSecret
  const settings = settingsSchema.parse({ ...candidate, clientSecret })
  const redirect = new URL(settings.redirectUri)
  if (redirect.pathname !== '/auth/callback') {
    throw new Error('OIDC redirect URI path must be /auth/callback')
  }
  if (!settings.scopes.split(/\s+/).includes('openid')) {
    throw new Error('OIDC scopes must include openid')
  }
  setStoredValue(SETTINGS_KEY, encrypt(JSON.stringify(settings)))
  return publicOidcSettings()!
}

function cookies(request: IncomingMessage): Map<string, string> {
  const result = new Map<string, string>()
  for (const item of (request.headers.cookie ?? '').split(';')) {
    const separator = item.indexOf('=')
    if (separator < 0) continue
    result.set(
      item.slice(0, separator).trim(),
      decodeURIComponent(item.slice(separator + 1).trim())
    )
  }
  return result
}

function secureCookie(request: IncomingMessage): boolean {
  if (process.env.WEB_SECURE_COOKIES === 'false') return false
  return (
    request.headers['x-forwarded-proto'] === 'https' ||
    !/^localhost(?::|$)/i.test(request.headers.host ?? '')
  )
}

function setSessionCookie(request: IncomingMessage, response: ServerResponse, token: string): void {
  response.setHeader(
    'Set-Cookie',
    `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_TTL_MS / 1000}${secureCookie(request) ? '; Secure' : ''}`
  )
}

function setFlowCookie(request: IncomingMessage, response: ServerResponse, state: string): void {
  response.setHeader(
    'Set-Cookie',
    `${FLOW_COOKIE}=${state}; Path=/auth/callback; HttpOnly; SameSite=Lax; Max-Age=${OIDC_FLOW_TTL_MS / 1000}${secureCookie(request) ? '; Secure' : ''}`
  )
}

export function clearSessionCookie(request: IncomingMessage, response: ServerResponse): void {
  response.setHeader(
    'Set-Cookie',
    `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secureCookie(request) ? '; Secure' : ''}`
  )
}

function createSession(
  request: IncomingMessage,
  response: ServerResponse,
  user: WebUser,
  idToken?: string
): WebSession {
  const token = randomBytes(32).toString('base64url')
  const session = {
    user,
    csrfToken: randomBytes(24).toString('base64url'),
    expiresAt: Date.now() + SESSION_TTL_MS,
    idToken
  }
  sessions.set(token, session)
  setSessionCookie(request, response, token)
  return session
}

export function getWebSession(request: IncomingMessage): WebSession | null {
  const token = cookies(request).get(SESSION_COOKIE)
  if (!token) return null
  const session = sessions.get(token)
  if (!session || session.expiresAt <= Date.now()) {
    sessions.delete(token)
    return null
  }
  return session
}

function equalSecret(actual: string, expected: string): boolean {
  const actualHash = createHash('sha256').update(actual).digest()
  const expectedHash = createHash('sha256').update(expected).digest()
  return timingSafeEqual(actualHash, expectedHash)
}

export function bootstrapLogin(
  request: IncomingMessage,
  response: ServerResponse,
  secret: unknown
): WebSession | null {
  const expected = process.env.WEB_ADMIN_BOOTSTRAP_SECRET?.trim()
  if (!expected || typeof secret !== 'string' || !equalSecret(secret, expected)) return null
  return createSession(request, response, {
    id: 'web:bootstrap-admin',
    subject: 'bootstrap-admin',
    name: 'Bootstrap administrator',
    admin: true,
    allowed: true,
    bootstrap: true
  })
}

export function requireCsrf(request: IncomingMessage, session: WebSession): boolean {
  const token = request.headers['x-csrf-token']
  return typeof token === 'string' && equalSecret(token, session.csrfToken)
}

async function oidcConfiguration(settings: OidcSettings): Promise<oidc.Configuration> {
  return oidc.discovery(
    new URL(settings.issuerUrl),
    settings.clientId,
    undefined,
    oidc.ClientSecretPost(settings.clientSecret)
  )
}

function safeReturnTo(value: string): string {
  if (!value.startsWith('/') || value.startsWith('//') || value.includes('\\')) return '/'
  const base = new URL('https://solver.invalid')
  const target = new URL(value, base)
  return target.origin === base.origin ? `${target.pathname}${target.search}${target.hash}` : '/'
}

export async function beginOidcLogin(
  request: IncomingMessage,
  response: ServerResponse,
  returnTo = '/'
): Promise<URL> {
  const settings = loadOidcSettings()
  if (!settings?.enabled) throw new Error('OIDC login is not enabled')
  const now = Date.now()
  for (const [key, flow] of flows) if (flow.expiresAt <= now) flows.delete(key)
  const configuration = await oidcConfiguration(settings)
  const codeVerifier = oidc.randomPKCECodeVerifier()
  const state = oidc.randomState()
  const nonce = oidc.randomNonce()
  const flow: OidcFlow = {
    state,
    nonce,
    codeVerifier,
    returnTo: safeReturnTo(returnTo),
    expiresAt: Date.now() + OIDC_FLOW_TTL_MS
  }
  flows.set(state, flow)
  setFlowCookie(request, response, state)
  return oidc.buildAuthorizationUrl(configuration, {
    redirect_uri: settings.redirectUri,
    scope: settings.scopes,
    code_challenge: await oidc.calculatePKCECodeChallenge(codeVerifier),
    code_challenge_method: 'S256',
    state,
    nonce
  })
}

function subjectSet(value: string): Set<string> {
  return new Set(value.split(/[\s,]+/).filter(Boolean))
}

export async function completeOidcLogin(
  request: IncomingMessage,
  response: ServerResponse,
  callbackUrl: URL
): Promise<string> {
  const settings = loadOidcSettings()
  if (!settings?.enabled) throw new Error('OIDC login is not enabled')
  const state = callbackUrl.searchParams.get('state') ?? ''
  if (cookies(request).get(FLOW_COOKIE) !== state) throw new Error('Invalid OIDC login browser')
  const flow = flows.get(state)
  flows.delete(state)
  if (!flow || flow.expiresAt <= Date.now()) throw new Error('Invalid or expired OIDC login')
  const configuration = await oidcConfiguration(settings)
  const tokens = await oidc.authorizationCodeGrant(configuration, callbackUrl, {
    pkceCodeVerifier: flow.codeVerifier,
    expectedState: flow.state,
    expectedNonce: flow.nonce,
    idTokenExpected: true
  })
  const claims = tokens.claims()
  if (!claims?.sub) throw new Error('OIDC provider did not return a subject')
  const subject = claims.sub
  const administrators = new Set([
    ...subjectSet(process.env.WEB_ADMIN_OIDC_SUBJECTS ?? ''),
    ...subjectSet(settings.adminSubjects)
  ])
  const admin = administrators.has(subject)
  const allowedSubjects = subjectSet(settings.allowedSubjects)
  const email = typeof claims.email === 'string' ? claims.email : undefined
  const name =
    (typeof claims.name === 'string' && claims.name) ||
    (typeof claims.preferred_username === 'string' && claims.preferred_username) ||
    email ||
    subject
  createSession(
    request,
    response,
    {
      id: `web:${encodeURIComponent(settings.issuerUrl)}:${encodeURIComponent(subject)}`,
      subject,
      name,
      email,
      admin,
      allowed: admin || allowedSubjects.has(subject) || allowedSubjects.has('*'),
      bootstrap: false
    },
    tokens.id_token
  )
  return flow.returnTo
}

export async function logoutUrl(request: IncomingMessage): Promise<URL | null> {
  const settings = loadOidcSettings()
  const session = getWebSession(request)
  const token = cookies(request).get(SESSION_COOKIE)
  if (token) sessions.delete(token)
  if (!settings?.enabled) return null
  const configuration = await oidcConfiguration(settings)
  const metadata = configuration.serverMetadata()
  if (!metadata.end_session_endpoint) return null
  const target = new URL(metadata.end_session_endpoint)
  if (session?.idToken) target.searchParams.set('id_token_hint', session.idToken)
  if (settings.postLogoutRedirectUri) {
    target.searchParams.set('post_logout_redirect_uri', settings.postLogoutRedirectUri)
  }
  return target
}

export function resetWebAuthForTests(): void {
  sessions.clear()
  flows.clear()
}
