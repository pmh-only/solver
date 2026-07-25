import { createHash, randomBytes } from 'node:crypto'
import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { getDefaultKvStorePath } from './helpers/kv-store-path.js'

const CALLBACK_PATH = '/mcp/spotify/callback'
const AUTHORIZATION_URL = 'https://accounts.spotify.com/authorize'
const TOKEN_URL = 'https://accounts.spotify.com/api/token'
const AUTH_TTL_MS = 10 * 60 * 1000
const TOKEN_TIMEOUT_MS = 10_000
const SCOPES = [
  'user-read-private',
  'user-read-email',
  'user-read-playback-state',
  'user-modify-playback-state',
  'user-read-currently-playing',
  'user-read-recently-played',
  'user-read-playback-position',
  'user-top-read',
  'user-library-read',
  'user-library-modify',
  'user-follow-read',
  'user-follow-modify',
  'playlist-read-private',
  'playlist-read-collaborative',
  'playlist-modify-public',
  'playlist-modify-private'
].join(' ')

interface PendingAuthentication {
  clientId: string
  redirectUri: string
  verifier: string
  expiresAt: number
}

interface SpotifyConfiguration {
  clientId: string
  redirectUri: string
  home: string
}

export interface SpotifyCallbackResult {
  status: number
  body: string
}

const pendingAuthentications = new Map<string, PendingAuthentication>()

function base64Url(value: Buffer): string {
  return value.toString('base64url')
}

function spotifyHome(): string {
  return resolve(dirname(getDefaultKvStorePath()))
}

function spotifyDirectory(): string {
  return join(spotifyHome(), '.spotify-mcp')
}

function validateRedirectUri(value: string): string {
  const url = new URL(value)
  const localHttp = url.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(url.hostname)
  if (url.protocol !== 'https:' && !localHttp) {
    throw new Error('Spotify redirect URI must use HTTPS (or HTTP on localhost)')
  }
  if (url.pathname !== CALLBACK_PATH || url.search || url.hash) {
    throw new Error(`Spotify redirect URI must end exactly in ${CALLBACK_PATH}`)
  }
  return url.toString()
}

async function writePrivateJson(path: string, value: unknown): Promise<void> {
  const directory = dirname(path)
  const temporaryPath = `${path}.${randomBytes(8).toString('hex')}.tmp`
  await mkdir(directory, { recursive: true })
  await writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 })
  await rename(temporaryPath, path)
  await chmod(path, 0o600)
}

export function beginSpotifyAuthentication(
  clientIdValue: string,
  redirectUriValue: string
): string {
  const clientId = clientIdValue.trim()
  if (!clientId || clientId.length > 256) throw new Error('A valid Spotify client ID is required')
  const redirectUri = validateRedirectUri(redirectUriValue.trim())
  const verifier = base64Url(randomBytes(32))
  const state = base64Url(randomBytes(24))
  const challenge = base64Url(createHash('sha256').update(verifier).digest())

  const now = Date.now()
  for (const [key, pending] of pendingAuthentications) {
    if (pending.expiresAt <= now) pendingAuthentications.delete(key)
  }
  pendingAuthentications.set(state, {
    clientId,
    redirectUri,
    verifier,
    expiresAt: now + AUTH_TTL_MS
  })

  const params = new URLSearchParams({
    response_type: 'code',
    client_id: clientId,
    redirect_uri: redirectUri,
    scope: SCOPES,
    code_challenge_method: 'S256',
    code_challenge: challenge,
    state
  })
  return `${AUTHORIZATION_URL}?${params}`
}

export async function handleSpotifyCallback(url: URL): Promise<SpotifyCallbackResult> {
  const state = url.searchParams.get('state') ?? ''
  const pending = pendingAuthentications.get(state)
  if (!pending || pending.expiresAt <= Date.now()) {
    if (pending) pendingAuthentications.delete(state)
    return { status: 400, body: 'Spotify authentication request is invalid or expired.' }
  }
  pendingAuthentications.delete(state)

  const spotifyError = url.searchParams.get('error')
  if (spotifyError) {
    return { status: 400, body: `Spotify authentication was denied (${spotifyError}).` }
  }
  const code = url.searchParams.get('code')
  if (!code) return { status: 400, body: 'Spotify did not provide an authorization code.' }

  try {
    const tokenResponse = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        redirect_uri: pending.redirectUri,
        client_id: pending.clientId,
        code_verifier: pending.verifier
      }),
      signal: AbortSignal.timeout(TOKEN_TIMEOUT_MS)
    })
    if (!tokenResponse.ok) {
      return {
        status: 502,
        body: 'Spotify rejected the token exchange. Start authentication again.'
      }
    }
    const tokens = (await tokenResponse.json()) as {
      access_token?: string
      refresh_token?: string
      expires_in?: number
    }
    if (!tokens.access_token || !tokens.refresh_token || !Number.isFinite(tokens.expires_in)) {
      return { status: 502, body: 'Spotify returned an invalid token response.' }
    }

    await writePrivateJson(join(spotifyDirectory(), 'tokens.json'), {
      access_token: tokens.access_token,
      refresh_token: tokens.refresh_token,
      expires_at: Date.now() + tokens.expires_in! * 1000
    })
    await writePrivateJson(join(spotifyDirectory(), 'config.json'), {
      clientId: pending.clientId,
      redirectUri: pending.redirectUri
    })
    return { status: 200, body: 'Spotify authentication succeeded. You can close this tab.' }
  } catch {
    return { status: 502, body: 'Spotify authentication could not be completed. Start again.' }
  }
}

export async function loadSpotifyConfiguration(): Promise<SpotifyConfiguration | undefined> {
  const environmentClientId = process.env.SPOTIFY_CLIENT_ID?.trim()
  if (environmentClientId) {
    return {
      clientId: environmentClientId,
      redirectUri: process.env.SPOTIFY_REDIRECT_URI?.trim() ?? 'http://127.0.0.1:8888/callback',
      home: process.env.HOME?.trim() || homedir()
    }
  }

  try {
    const value = JSON.parse(
      await readFile(join(spotifyDirectory(), 'config.json'), 'utf8')
    ) as Partial<SpotifyConfiguration>
    if (!value.clientId || !value.redirectUri) return undefined
    return { clientId: value.clientId, redirectUri: value.redirectUri, home: spotifyHome() }
  } catch {
    return undefined
  }
}

export function getSpotifyMcpEnvironment(
  configuration: SpotifyConfiguration
): Record<string, string> {
  return {
    HOME: configuration.home,
    PATH: process.env.PATH ?? '',
    SPOTIFY_CLIENT_ID: configuration.clientId,
    SPOTIFY_REDIRECT_URI: configuration.redirectUri
  }
}
