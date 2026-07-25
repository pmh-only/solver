import { afterEach, describe, expect, it, vi } from 'vitest'
import { readFile, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import {
  beginSpotifyAuthentication,
  getSpotifyMcpEnvironment,
  handleSpotifyCallback,
  loadSpotifyConfiguration
} from '../spotify-auth.js'

const testDirectory = join(process.cwd(), '.tmp', 'spotify-auth-test')
const previousKvStorePath = process.env.KV_STORE_PATH

afterEach(async () => {
  vi.restoreAllMocks()
  if (previousKvStorePath === undefined) delete process.env.KV_STORE_PATH
  else process.env.KV_STORE_PATH = previousKvStorePath
  delete process.env.SPOTIFY_CLIENT_ID
  delete process.env.SPOTIFY_REDIRECT_URI
  await rm(testDirectory, { recursive: true, force: true })
})

describe('Spotify agent authentication', () => {
  it('creates a PKCE URL and persists tokens for Spotify MCP after the callback', async () => {
    process.env.KV_STORE_PATH = join(testDirectory, 'kv.sqlite')
    const redirectUri = 'https://solver.example/mcp/spotify/callback'
    const authorizationUrl = new URL(beginSpotifyAuthentication('client-id', redirectUri))
    const state = authorizationUrl.searchParams.get('state')

    expect(authorizationUrl.origin).toBe('https://accounts.spotify.com')
    expect(authorizationUrl.searchParams.get('client_id')).toBe('client-id')
    expect(authorizationUrl.searchParams.get('redirect_uri')).toBe(redirectUri)
    expect(authorizationUrl.searchParams.get('code_challenge_method')).toBe('S256')
    expect(authorizationUrl.searchParams.get('code_challenge')).toBeTruthy()

    const tokenFetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      Response.json({
        access_token: 'access-token',
        refresh_token: 'refresh-token',
        expires_in: 3600
      })
    )
    const result = await handleSpotifyCallback(
      new URL(`${redirectUri}?code=authorization-code&state=${state}`)
    )

    expect(result).toEqual({
      status: 200,
      body: 'Spotify authentication succeeded. You can close this tab.'
    })
    expect(tokenFetch).toHaveBeenCalledWith(
      'https://accounts.spotify.com/api/token',
      expect.objectContaining({ method: 'POST' })
    )
    const tokenRequest = tokenFetch.mock.calls[0]?.[1]
    expect(String(tokenRequest?.body)).toContain('code_verifier=')
    expect(String(tokenRequest?.body)).toContain('code=authorization-code')

    const spotifyDirectory = join(testDirectory, '.spotify-mcp')
    const tokens = JSON.parse(await readFile(join(spotifyDirectory, 'tokens.json'), 'utf8'))
    expect(tokens).toMatchObject({
      access_token: 'access-token',
      refresh_token: 'refresh-token'
    })
    expect((await stat(join(spotifyDirectory, 'tokens.json'))).mode & 0o777).toBe(0o600)

    const configuration = await loadSpotifyConfiguration()
    expect(configuration).toMatchObject({ clientId: 'client-id', redirectUri })
    expect(getSpotifyMcpEnvironment(configuration!)).toMatchObject({
      HOME: testDirectory,
      SPOTIFY_CLIENT_ID: 'client-id',
      SPOTIFY_REDIRECT_URI: redirectUri
    })
  })

  it('rejects unsafe or incorrect callback URIs', () => {
    expect(() =>
      beginSpotifyAuthentication('client-id', 'http://solver.example/mcp/spotify/callback')
    ).toThrow('must use HTTPS')
    expect(() =>
      beginSpotifyAuthentication('client-id', 'https://solver.example/callback')
    ).toThrow('must end exactly')
  })

  it('consumes state once to prevent callback replay', async () => {
    process.env.KV_STORE_PATH = join(testDirectory, 'kv.sqlite')
    const redirectUri = 'https://solver.example/mcp/spotify/callback'
    const authorizationUrl = new URL(beginSpotifyAuthentication('client-id', redirectUri))
    const callback = new URL(
      `${redirectUri}?error=access_denied&state=${authorizationUrl.searchParams.get('state')}`
    )

    expect(await handleSpotifyCallback(callback)).toMatchObject({ status: 400 })
    expect(await handleSpotifyCallback(callback)).toEqual({
      status: 400,
      body: 'Spotify authentication request is invalid or expired.'
    })
  })
})
