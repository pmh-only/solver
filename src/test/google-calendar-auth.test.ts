import { afterEach, describe, expect, it, vi } from 'vitest'
import { readFile, rm, stat, writeFile, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import {
  beginGoogleCalendarAuthentication,
  getGoogleCalendarMcpEnvironment,
  handleGoogleCalendarCallback,
  loadGoogleCalendarConfiguration
} from '../google-calendar-auth.js'

const testDirectory = join(process.cwd(), '.tmp', 'google-calendar-auth-test')
const previousKvStorePath = process.env.KV_STORE_PATH

afterEach(async () => {
  vi.restoreAllMocks()
  if (previousKvStorePath === undefined) delete process.env.KV_STORE_PATH
  else process.env.KV_STORE_PATH = previousKvStorePath
  delete process.env.GOOGLE_OAUTH_CREDENTIALS
  delete process.env.GOOGLE_CALENDAR_REDIRECT_URI
  await rm(testDirectory, { recursive: true, force: true })
})

async function configureGoogleCalendar(): Promise<string> {
  await mkdir(testDirectory, { recursive: true })
  const credentialsPath = join(testDirectory, 'oauth.json')
  await writeFile(
    credentialsPath,
    JSON.stringify({
      web: {
        client_id: 'google-client-id',
        client_secret: 'google-client-secret',
        token_uri: 'https://oauth2.googleapis.com/token'
      }
    })
  )
  process.env.KV_STORE_PATH = join(testDirectory, 'kv.sqlite')
  process.env.GOOGLE_OAUTH_CREDENTIALS = credentialsPath
  process.env.GOOGLE_CALENDAR_REDIRECT_URI = 'https://solver.example/mcp/google-calendar/callback'
  return credentialsPath
}

describe('Google Calendar agent authentication', () => {
  it('creates a PKCE URL and persists MCP-compatible tokens after the callback', async () => {
    await configureGoogleCalendar()
    const authorizationUrl = new URL(await beginGoogleCalendarAuthentication('Work'))
    const state = authorizationUrl.searchParams.get('state')

    expect(authorizationUrl.origin).toBe('https://accounts.google.com')
    expect(authorizationUrl.searchParams.get('client_id')).toBe('google-client-id')
    expect(authorizationUrl.searchParams.get('code_challenge_method')).toBe('S256')
    expect(authorizationUrl.searchParams.get('access_type')).toBe('offline')

    const tokenFetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      Response.json({
        access_token: 'access-token',
        refresh_token: 'refresh-token',
        expires_in: 3600,
        token_type: 'Bearer'
      })
    )
    const result = await handleGoogleCalendarCallback(
      new URL(
        `https://solver.example/mcp/google-calendar/callback?code=authorization-code&state=${state}`
      )
    )

    expect(result).toEqual({
      status: 200,
      body: 'Google Calendar account "work" authenticated. You can close this tab.'
    })
    const tokenRequest = tokenFetch.mock.calls[0]?.[1]
    expect(String(tokenRequest?.body)).toContain('code_verifier=')
    expect(String(tokenRequest?.body)).toContain('client_secret=google-client-secret')

    const directory = join(testDirectory, '.google-calendar-mcp')
    const tokens = JSON.parse(await readFile(join(directory, 'tokens.json'), 'utf8'))
    expect(tokens.work).toMatchObject({
      access_token: 'access-token',
      refresh_token: 'refresh-token'
    })
    expect((await stat(join(directory, 'tokens.json'))).mode & 0o777).toBe(0o600)

    const configuration = await loadGoogleCalendarConfiguration()
    expect(getGoogleCalendarMcpEnvironment(configuration!)).toMatchObject({
      GOOGLE_OAUTH_CREDENTIALS: join(directory, 'credentials.json'),
      GOOGLE_CALENDAR_MCP_TOKEN_PATH: join(directory, 'tokens.json')
    })
  })

  it('rejects unsafe callbacks and consumes state once', async () => {
    await configureGoogleCalendar()
    process.env.GOOGLE_CALENDAR_REDIRECT_URI = 'http://solver.example/mcp/google-calendar/callback'
    await expect(beginGoogleCalendarAuthentication('personal')).rejects.toThrow('must use HTTPS')

    process.env.GOOGLE_CALENDAR_REDIRECT_URI = 'https://solver.example/mcp/google-calendar/callback'
    const authorizationUrl = new URL(await beginGoogleCalendarAuthentication('personal'))
    const callback = new URL(
      `https://solver.example/mcp/google-calendar/callback?error=access_denied&state=${authorizationUrl.searchParams.get('state')}`
    )
    await expect(handleGoogleCalendarCallback(callback)).resolves.toMatchObject({ status: 400 })
    await expect(handleGoogleCalendarCallback(callback)).resolves.toEqual({
      status: 400,
      body: 'Google Calendar authentication request is invalid or expired.'
    })
  })
})
