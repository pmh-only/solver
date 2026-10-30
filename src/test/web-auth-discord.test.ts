import { join } from 'node:path'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import {
  beginOidcLogin,
  completeOidcLogin,
  getWebSession,
  resetWebAuthForTests,
  saveOidcSettings
} from '../web-auth.js'
import { clearStoredValues } from '../helpers/kv-store.js'
import { isolateStoredValues } from '../helpers/kv-store-test.js'

const { grant, claims } = vi.hoisted(() => ({
  grant: vi.fn(),
  claims: { sub: 'member', name: 'Member', discord_id: '555555555555555555' } as Record<
    string,
    unknown
  >
}))
vi.mock('openid-client', () => ({
  discovery: vi.fn().mockResolvedValue({}),
  ClientSecretPost: vi.fn(),
  randomPKCECodeVerifier: () => 'verifier',
  randomState: () => 'state',
  randomNonce: () => 'nonce',
  calculatePKCECodeChallenge: vi.fn().mockResolvedValue('challenge'),
  buildAuthorizationUrl: () => new URL('https://issuer.example/authorize'),
  authorizationCodeGrant: grant
}))
beforeEach(() => {
  isolateStoredValues(join(process.cwd(), '.tmp', 'web-auth-discord.test.sqlite'))
  clearStoredValues()
  resetWebAuthForTests()
  vi.clearAllMocks()
  claims.discord_id = '555555555555555555'
  grant.mockResolvedValue({ claims: () => claims, id_token: 'test-id-token' })
  saveOidcSettings({
    enabled: true,
    issuerUrl: 'https://issuer.example/',
    clientId: 'solver',
    clientSecret: 'private-client-secret',
    redirectUri: 'https://solver.example/auth/callback',
    scopes: 'openid profile',
    automaticLogin: true,
    postLogoutRedirectUri: '',
    allowedSubjects: 'administrator',
    adminSubjects: 'administrator'
  })
})
afterEach(() => {
  resetWebAuthForTests()
  clearStoredValues()
})
function response() {
  const headers = new Map<string, string>()
  return {
    headers,
    res: {
      setHeader: (name: string, value: string) => headers.set(name, value)
    } as unknown as ServerResponse
  }
}
async function login() {
  const started = response()
  await beginOidcLogin(
    { headers: { host: 'solver.example' } } as IncomingMessage,
    started.res,
    '/search'
  )
  const completed = response()
  const target = await completeOidcLogin(
    { headers: { host: 'solver.example', cookie: 'solver_oidc_state=state' } } as IncomingMessage,
    completed.res,
    new URL('https://solver.example/auth/callback?state=state&code=authorization-code')
  )
  const session = getWebSession({
    headers: { cookie: completed.headers.get('Set-Cookie')!.split(';')[0] }
  } as IncomingMessage)
  return { target, session }
}
it('uses the verified OIDC Discord identity without granting assistant or administrator access', async () => {
  const { target, session } = await login()
  expect(target).toBe('/search')
  expect(session?.user).toMatchObject({
    discordId: '555555555555555555',
    allowed: false,
    admin: false
  })
  expect(grant).toHaveBeenCalledWith(
    expect.anything(),
    expect.any(URL),
    expect.objectContaining({
      expectedState: 'state',
      expectedNonce: 'nonce',
      pkceCodeVerifier: 'verifier',
      idTokenExpected: true
    })
  )
})
it.each([null, 12345, 'not-an-id', '1', '５'.repeat(18)])(
  'does not infer Discord identities from names or malformed claims %s',
  async (value) => {
    claims.discord_id = value
    const { session } = await login()
    expect(session?.user.discordId).toBeUndefined()
  }
)
