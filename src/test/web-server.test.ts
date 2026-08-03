import { afterEach, describe, expect, it, vi } from 'vitest'
import { readFile, rm } from 'node:fs/promises'
import type { AddressInfo } from 'node:net'
import type { Server } from 'node:http'
import {
  HOSTED_HTML_PATH,
  MAX_HOSTED_HTML_BYTES,
  hostedPageUrl,
  writeHostedHtml
} from '../hosted-page.js'
import { closeWebServer, startWebServer } from '../web-server.js'
import { clearModelCache } from '../model-catalog.js'
import { deleteStoredValue } from '../helpers/kv-store.js'
import { resetWebAuthForTests } from '../web-auth.js'

let server: Server | undefined

afterEach(async () => {
  vi.restoreAllMocks()
  clearModelCache()
  delete process.env.WEB_DOMAIN
  delete process.env.OPENAI_API_KEY
  delete process.env.WEB_SESSION_SECRET
  delete process.env.WEB_ADMIN_BOOTSTRAP_SECRET
  resetWebAuthForTests()
  deleteStoredValue('web-oidc-settings')
  await rm(HOSTED_HTML_PATH, { force: true })
  if (server) {
    await closeWebServer(server)
    server = undefined
  }
})

async function startServer(): Promise<string> {
  server = await startWebServer({ host: '127.0.0.1', port: 0 })
  const address = server.address() as AddressInfo
  return `http://127.0.0.1:${address.port}`
}

describe('web server', () => {
  it('serves the responsive chat application', async () => {
    const origin = await startServer()
    const response = await fetch(`${origin}/`)
    const html = await response.text()

    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toBe('text/html; charset=utf-8')
    expect(response.headers.get('content-security-policy')).toContain('frame-ancestors')
    expect(html).toContain('<h1>Ask Solver from anywhere.</h1>')
    expect(html).toContain('id="composer"')
    expect(html).toContain('name="viewport"')
  })

  it('serves health checks and HEAD requests', async () => {
    const origin = await startServer()
    const health = await fetch(`${origin}/healthz`)
    const head = await fetch(`${origin}/`, { method: 'HEAD' })

    expect(health.status).toBe(200)
    expect(await health.text()).toBe('ok\n')
    expect(head.status).toBe(200)
    expect(await head.text()).toBe('')
    expect(Number(head.headers.get('content-length'))).toBeGreaterThan(0)
  })

  it('serves models loaded dynamically from OpenAI', async () => {
    process.env.OPENAI_API_KEY = 'test-key'
    const nativeFetch = globalThis.fetch
    const upstreamFetch = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementation((input: string | URL | Request, init?: RequestInit) => {
        if (String(input) === 'https://api.openai.com/v1/models') {
          return Promise.resolve(
            new Response(
              JSON.stringify({
                data: [
                  { id: 'provider-model-b' },
                  { id: 'provider-model-a' },
                  { id: 'provider-model-a' }
                ]
              }),
              { status: 200 }
            )
          )
        }
        return nativeFetch(input, init)
      })
    const origin = await startServer()

    const response = await fetch(`${origin}/models`)
    const cachedResponse = await fetch(`${origin}/models`)

    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toBe('application/json; charset=utf-8')
    expect(await response.json()).toEqual({ models: ['provider-model-a', 'provider-model-b'] })
    expect(await cachedResponse.json()).toEqual({
      models: ['provider-model-a', 'provider-model-b']
    })
    expect(upstreamFetch).toHaveBeenCalledWith('https://api.openai.com/v1/models', {
      headers: { Authorization: 'Bearer test-key' }
    })
    expect(
      upstreamFetch.mock.calls.filter(
        ([input]) => String(input) === 'https://api.openai.com/v1/models'
      )
    ).toHaveLength(1)
  })

  it('atomically publishes and serves one persistent HTML file', async () => {
    const html =
      '<!doctype html><html><body><script>document.body.dataset.ready="yes"</script></body></html>'
    await writeHostedHtml(html)
    const origin = await startServer()

    const response = await fetch(`${origin}/hosted`)

    expect(response.status).toBe(200)
    expect(await response.text()).toBe(html)
    expect(response.headers.get('content-security-policy')).toContain('sandbox')
    expect(response.headers.get('content-security-policy')).not.toContain('allow-same-origin')
    expect(await readFile(HOSTED_HTML_PATH, 'utf8')).toBe(html)
  })

  it('validates hosted HTML and normalizes WEB_DOMAIN', async () => {
    await expect(writeHostedHtml('')).rejects.toThrow('HTML must not be empty')
    await expect(writeHostedHtml('x'.repeat(MAX_HOSTED_HTML_BYTES + 1))).rejects.toThrow(
      'HTML must not exceed 1 MiB'
    )

    process.env.WEB_DOMAIN = 'pages.example.com'
    expect(hostedPageUrl()).toBe('https://pages.example.com/hosted')
    process.env.WEB_DOMAIN = 'http://localhost:3000'
    expect(hostedPageUrl()).toBe('http://localhost:3000/hosted')
  })

  it('protects chat and lets a bootstrap administrator configure OIDC without exposing secrets', async () => {
    process.env.WEB_SESSION_SECRET = 'test-session-secret-that-is-at-least-32-characters'
    process.env.WEB_ADMIN_BOOTSTRAP_SECRET = 'test-bootstrap-secret'
    const origin = await startServer()

    const unauthorized = await fetch(`${origin}/api/chat/history`)
    expect(unauthorized.status).toBe(401)

    const login = await fetch(`${origin}/api/auth/bootstrap`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ secret: 'test-bootstrap-secret' })
    })
    const loginBody = (await login.json()) as { csrfToken: string }
    const cookie = login.headers.get('set-cookie')!.split(';', 1)[0]!
    expect(login.status).toBe(200)

    const saved = await fetch(`${origin}/api/admin/oidc`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        Cookie: cookie,
        'X-CSRF-Token': loginBody.csrfToken
      },
      body: JSON.stringify({
        enabled: true,
        issuerUrl: 'https://identity.example.com',
        clientId: 'solver',
        clientSecret: 'confidential-test-value',
        redirectUri: 'https://solver.example.com/auth/callback',
        scopes: 'openid profile email',
        allowedSubjects: 'trusted-user',
        adminSubjects: 'trusted-admin',
        automaticLogin: false,
        postLogoutRedirectUri: 'https://solver.example.com/'
      })
    })
    const savedBody = (await saved.json()) as Record<string, unknown>
    expect(saved.status).toBe(200)
    expect(savedBody.hasClientSecret).toBe(true)
    expect(savedBody).not.toHaveProperty('clientSecret')

    const loaded = await fetch(`${origin}/api/admin/oidc`, { headers: { Cookie: cookie } })
    expect(await loaded.text()).not.toContain('confidential-test-value')
  })

  it('rejects unknown routes and unsupported methods', async () => {
    const origin = await startServer()
    const missing = await fetch(`${origin}/missing`)
    const post = await fetch(`${origin}/`, { method: 'POST' })

    expect(missing.status).toBe(404)
    expect(post.status).toBe(405)
    expect(post.headers.get('allow')).toBe('GET, HEAD')
  })

  it('rejects Spotify callbacks that were not initiated by the agent', async () => {
    const origin = await startServer()
    const response = await fetch(`${origin}/mcp/spotify/callback?code=auth-code&state=auth-state`)

    expect(response.status).toBe(400)
    expect(await response.text()).toContain('invalid or expired')
  })

  it('rejects Google Calendar callbacks that were not initiated by the agent', async () => {
    const origin = await startServer()
    const response = await fetch(
      `${origin}/mcp/google-calendar/callback?code=auth-code&state=auth-state`
    )

    expect(response.status).toBe(400)
    expect(await response.text()).toContain('invalid or expired')
  })

  it('rejects an invalid PORT configuration', async () => {
    const previousPort = process.env.PORT
    process.env.PORT = 'not-a-port'
    try {
      await expect(startWebServer()).rejects.toThrow('PORT must be an integer between 1 and 65535')
    } finally {
      if (previousPort === undefined) delete process.env.PORT
      else process.env.PORT = previousPort
    }
  })
})
