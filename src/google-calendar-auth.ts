import { createHash, randomBytes } from 'node:crypto'
import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { getDefaultKvStorePath } from './helpers/kv-store-path.js'

const CALLBACK_PATH = '/mcp/google-calendar/callback'
const AUTHORIZATION_URL = 'https://accounts.google.com/o/oauth2/v2/auth'
const DEFAULT_TOKEN_URL = 'https://oauth2.googleapis.com/token'
const AUTH_TTL_MS = 10 * 60 * 1000
const TOKEN_TIMEOUT_MS = 10_000
const ACCOUNT_ID_PATTERN = /^[a-z0-9_-]{1,64}$/

interface GoogleCredentials {
  clientId: string
  clientSecret: string
}

interface PendingAuthentication extends GoogleCredentials {
  accountId: string
  redirectUri: string
  tokenPath: string
  verifier: string
  expiresAt: number
}

export interface GoogleCalendarConfiguration {
  credentialsPath: string
  redirectUri: string
  tokenPath: string
}

export interface GoogleCalendarCallbackResult {
  status: number
  body: string
}

const pendingAuthentications = new Map<string, PendingAuthentication>()
let tokenWriteQueue = Promise.resolve()

function calendarDirectory(): string {
  return join(resolve(dirname(getDefaultKvStorePath())), '.google-calendar-mcp')
}

function validateRedirectUri(value: string): string {
  const url = new URL(value)
  const localHttp = url.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(url.hostname)
  if (url.protocol !== 'https:' && !localHttp) {
    throw new Error('Google Calendar redirect URI must use HTTPS (or HTTP on localhost)')
  }
  if (url.pathname !== CALLBACK_PATH || url.search || url.hash) {
    throw new Error(`Google Calendar redirect URI must end exactly in ${CALLBACK_PATH}`)
  }
  return url.toString()
}

async function writePrivateJson(path: string, value: unknown): Promise<void> {
  const temporaryPath = `${path}.${randomBytes(8).toString('hex')}.tmp`
  await mkdir(dirname(path), { recursive: true })
  await writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 })
  await rename(temporaryPath, path)
  await chmod(path, 0o600)
}

function parseCredentials(json: string): GoogleCredentials {
  let value: Record<string, unknown>
  try {
    value = JSON.parse(json) as Record<string, unknown>
  } catch {
    throw new Error('Google OAuth credentials must be base64-encoded JSON')
  }
  const nested = (value.installed ?? value.web ?? value) as Record<string, unknown>
  const clientId = typeof nested.client_id === 'string' ? nested.client_id.trim() : ''
  const clientSecret = typeof nested.client_secret === 'string' ? nested.client_secret.trim() : ''
  if (!clientId || !clientSecret) {
    throw new Error('Google OAuth credentials must include client_id and client_secret')
  }
  return { clientId, clientSecret }
}

async function saveAccountTokens(path: string, accountId: string, tokens: unknown): Promise<void> {
  const write = tokenWriteQueue
    .catch(() => undefined)
    .then(async () => {
      let storedTokens: Record<string, unknown> = {}
      try {
        storedTokens = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>
      } catch (error) {
        if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error
      }
      storedTokens[accountId] = tokens
      await writePrivateJson(path, storedTokens)
    })
  tokenWriteQueue = write.catch(() => undefined)
  await write
}

export async function loadGoogleCalendarConfiguration(): Promise<
  GoogleCalendarConfiguration | undefined
> {
  const encodedCredentials = process.env.GOOGLE_OAUTH_CREDENTIALS_BASE64?.trim()
  const redirectValue = process.env.GOOGLE_CALENDAR_REDIRECT_URI?.trim()
  if (!encodedCredentials || !redirectValue) return undefined

  const credentials = parseCredentials(Buffer.from(encodedCredentials, 'base64').toString('utf8'))
  const directory = calendarDirectory()
  const credentialsPath = join(directory, 'credentials.json')
  const tokenPath = join(directory, 'tokens.json')
  const redirectUri = validateRedirectUri(redirectValue)
  await writePrivateJson(credentialsPath, {
    client_id: credentials.clientId,
    client_secret: credentials.clientSecret,
    redirect_uris: [redirectUri]
  })
  return { credentialsPath, redirectUri, tokenPath }
}

export async function beginGoogleCalendarAuthentication(accountIdValue: string): Promise<string> {
  const accountId = accountIdValue.trim().toLowerCase()
  if (!ACCOUNT_ID_PATTERN.test(accountId)) {
    throw new Error(
      'Google Calendar account nickname must be 1-64 lowercase letters, numbers, dashes, or underscores'
    )
  }
  const configuration = await loadGoogleCalendarConfiguration()
  if (!configuration) {
    throw new Error(
      'Google Calendar requires GOOGLE_OAUTH_CREDENTIALS_BASE64 and GOOGLE_CALENDAR_REDIRECT_URI'
    )
  }
  const credentials = parseCredentials(await readFile(configuration.credentialsPath, 'utf8'))
  const verifier = randomBytes(32).toString('base64url')
  const state = randomBytes(24).toString('base64url')
  const challenge = createHash('sha256').update(verifier).digest('base64url')

  const now = Date.now()
  for (const [key, pending] of pendingAuthentications) {
    if (pending.expiresAt <= now) pendingAuthentications.delete(key)
  }
  pendingAuthentications.set(state, {
    ...credentials,
    accountId,
    redirectUri: configuration.redirectUri,
    tokenPath: configuration.tokenPath,
    verifier,
    expiresAt: now + AUTH_TTL_MS
  })

  const params = new URLSearchParams({
    client_id: credentials.clientId,
    redirect_uri: configuration.redirectUri,
    response_type: 'code',
    scope: 'https://www.googleapis.com/auth/calendar',
    access_type: 'offline',
    prompt: 'consent',
    code_challenge_method: 'S256',
    code_challenge: challenge,
    state
  })
  return `${AUTHORIZATION_URL}?${params}`
}

export async function handleGoogleCalendarCallback(
  url: URL
): Promise<GoogleCalendarCallbackResult> {
  const state = url.searchParams.get('state') ?? ''
  const pending = pendingAuthentications.get(state)
  if (!pending || pending.expiresAt <= Date.now()) {
    if (pending) pendingAuthentications.delete(state)
    return { status: 400, body: 'Google Calendar authentication request is invalid or expired.' }
  }
  pendingAuthentications.delete(state)

  const googleError = url.searchParams.get('error')
  if (googleError) {
    return { status: 400, body: `Google Calendar authentication was denied (${googleError}).` }
  }
  const code = url.searchParams.get('code')
  if (!code) return { status: 400, body: 'Google did not provide an authorization code.' }

  try {
    const tokenResponse = await fetch(DEFAULT_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        redirect_uri: pending.redirectUri,
        client_id: pending.clientId,
        client_secret: pending.clientSecret,
        code_verifier: pending.verifier
      }),
      signal: AbortSignal.timeout(TOKEN_TIMEOUT_MS)
    })
    if (!tokenResponse.ok) {
      return {
        status: 502,
        body: 'Google rejected the token exchange. Start authentication again.'
      }
    }
    const tokens = (await tokenResponse.json()) as {
      access_token?: string
      refresh_token?: string
      expires_in?: number
      scope?: string
      token_type?: string
    }
    if (!tokens.access_token || !tokens.refresh_token || !Number.isFinite(tokens.expires_in)) {
      return { status: 502, body: 'Google returned an invalid token response.' }
    }

    await saveAccountTokens(pending.tokenPath, pending.accountId, {
      access_token: tokens.access_token,
      refresh_token: tokens.refresh_token,
      expiry_date: Date.now() + tokens.expires_in! * 1000,
      scope: tokens.scope,
      token_type: tokens.token_type
    })
    return {
      status: 200,
      body: `Google Calendar account "${pending.accountId}" authenticated. You can close this tab.`
    }
  } catch {
    return {
      status: 502,
      body: 'Google Calendar authentication could not be completed. Start again.'
    }
  }
}

export function getGoogleCalendarMcpEnvironment(
  configuration: GoogleCalendarConfiguration
): Record<string, string> {
  return {
    PATH: process.env.PATH ?? '',
    GOOGLE_OAUTH_CREDENTIALS: configuration.credentialsPath,
    GOOGLE_CALENDAR_MCP_TOKEN_PATH: configuration.tokenPath
  }
}
