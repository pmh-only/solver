import { afterEach, describe, expect, it, vi } from 'vitest'
import { readFile, rm } from 'node:fs/promises'
import type { AddressInfo } from 'node:net'
import type { Server } from 'node:http'
import {
  HOSTED_HTML_PATH,
  MAX_HOSTED_HTML_BYTES,
  SHARED_HTML_DIRECTORY,
  hostedPageUrl,
  readSharedHtml,
  sharedPageUrl,
  writeSharedHtml,
  writeHostedHtml
} from '../hosted-page.js'
import { closeWebServer, startWebServer } from '../web-server.js'
import { clearModelCache } from '../model-catalog.js'
import { updateOpenAIEndpoint, updateOpenAIToken } from '../openai-config.js'
import {
  deleteStoredValue,
  getStoredValue,
  listStoredKeys,
  setStoredValue
} from '../helpers/kv-store.js'
import { createWebSessionForTests, resetWebAuthForTests } from '../web-auth.js'

let server: Server | undefined

afterEach(async () => {
  vi.restoreAllMocks()
  clearModelCache()
  delete process.env.WEB_DOMAIN
  delete process.env.OPENAI_API_KEY
  delete process.env.WEB_SESSION_SECRET
  delete process.env.WEB_ADMIN_OIDC_SUBJECTS
  resetWebAuthForTests()
  deleteStoredValue('web-oidc-settings')
  deleteStoredValue('web-session-secret')
  deleteStoredValue('global-system-prompt')
  deleteStoredValue('openai-endpoint')
  deleteStoredValue('openai-token')
  for (const key of listStoredKeys()) if (key.startsWith('web-rate:')) deleteStoredValue(key)
  await rm(HOSTED_HTML_PATH, { force: true })
  await rm(SHARED_HTML_DIRECTORY, { force: true, recursive: true })
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
    const script = await (await fetch(`${origin}/app.js`)).text()
    const markdownScript = await (await fetch(`${origin}/markdown.js`)).text()

    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toBe('text/html; charset=utf-8')
    expect(response.headers.get('content-security-policy')).toContain('frame-ancestors')
    expect(html).toContain('<h1>Ask Solver from anywhere.</h1>')
    expect(html).toContain('id="composer"')
    expect(script).toContain("if (prompt === '/clear')")
    expect(html).toContain('name="viewport"')
    expect(html).not.toContain('<aside')
    expect(html).toContain('id="session-select"')
    expect(html).toContain('id="model-select"')
    expect(html).toContain('id="model-options"')
    expect(html).toContain('id="effort"')
    expect(html).toContain('id="max-tokens"')
    expect(html).toContain('id="debug-mode"')
    expect(script).toContain('renderTiming(target, serverTiming, browserTiming)')
    expect(script).toContain("api('/models')")
    expect(script).toContain("api('/api/chat/sessions'")
    expect(script).toContain('sessionName: name')
    expect(script).toContain('data.selectedSession')
    expect(script).toContain('scheduleSessionPoll')
    expect(html).toContain('id="cancel-run"')
    expect(script).toContain("api('/api/chat/cancel'")
    expect(script).toContain('if (state.runs.has(name)) await cancelRun(name, true)')
    expect(script).toContain('function controlsDisabled(disabled)')
    expect(html).not.toContain('Bootstrap secret')
    expect(html).toContain('id="prompt-settings-view"')
    expect(html).toContain('id="session-prompt-settings-form"')
    expect(html).toContain('id="openai-endpoint-form"')
    expect(html).toContain('id="openai-token-form"')
    expect(script).toContain("api('/api/admin/system-prompt')")
    expect(script).toContain("api('/api/admin/openai-endpoint')")
    expect(script).toContain("api('/api/admin/openai-token')")
    expect(script).toContain("api('/api/chat/system-prompt")
    expect(script).toContain("queryElement('#admin-prompt').hidden = !yes")
    expect(script).not.toContain('$(')
    expect(html).toContain('id="interaction-modal"')
    expect(script).toContain('const componentRenderers =')
    expect(script).toContain('3: (c) => stringSelect(c)')
    expect(script).toContain('5: (c) => entitySelect(c)')
    expect(script).toContain('componentEmoji')
    expect(script).toContain('Unsupported Discord component')
    expect(script).toContain("api('/api/chat/interaction'")
    expect(html).toContain('id="jump-bottom"')
    expect(script).toContain('bottomThreshold = 72')
    expect(script).toContain('new MutationObserver(')
    expect(script).toContain('new ResizeObserver(contentChanged)')
    expect(script).toContain('messages.addEventListener(')
    expect(script).toContain("'scroll',")
    expect(markdownScript).toContain('function md(value)')
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

  it('streams server lifecycle timing for debug chat requests only', async () => {
    const origin = await startServer()
    const { cookie, csrfToken } = createWebSessionForTests({
      id: 'web:issuer:debug-user',
      subject: 'debug-user',
      name: 'Debug user',
      admin: false,
      allowed: true
    })
    const sendChat = (debug: boolean) =>
      fetch(`${origin}/api/chat`, {
        method: 'POST',
        headers: {
          Cookie: cookie,
          'Content-Type': 'application/json',
          'X-CSRF-Token': csrfToken
        },
        body: JSON.stringify({ prompt: debug ? 'debug request' : 'normal request', debug })
      })

    const normal = await (await sendChat(false)).text()
    const debug = await (await sendChat(true)).text()
    const updates = debug
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as Record<string, unknown>)
    const timing = updates.find((update) => update.timing)?.timing as {
      totalMs: number
      entries: Array<{ name: string }>
    }

    expect(normal).not.toContain('"timing"')
    expect(timing.totalMs).toBeGreaterThanOrEqual(0)
    expect(timing.entries.map(({ name }) => name)).toEqual(
      expect.arrayContaining([
        'request body parsed and authorized',
        'session queue wait',
        'conversation load',
        'agent stream started'
      ])
    )
    expect(updates.at(-1)).toMatchObject({ done: true })
  })

  it('serves models loaded dynamically from OpenAI', async () => {
    process.env.OPENAI_API_KEY = 'test-key'
    updateOpenAIEndpoint({ endpoint: 'https://inference.example.com/openai/v1' }, 'admin')
    updateOpenAIToken({ token: 'override-model-token' }, 'admin')
    const nativeFetch = globalThis.fetch
    const upstreamFetch = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementation((input: string | URL | Request, init?: RequestInit) => {
        if (String(input) === 'https://inference.example.com/openai/v1/models') {
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
    expect(upstreamFetch).toHaveBeenCalledWith('https://inference.example.com/openai/v1/models', {
      headers: { Authorization: 'Bearer override-model-token' }
    })
    expect(
      upstreamFetch.mock.calls.filter(
        ([input]) => String(input) === 'https://inference.example.com/openai/v1/models'
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

  it('publishes independent persistent HTML pages at UUID paths', async () => {
    const firstHtml = '<!doctype html><title>First</title>'
    const secondHtml = '<!doctype html><title>Second</title>'
    const firstId = await writeSharedHtml(firstHtml)
    const secondId = await writeSharedHtml(secondHtml)
    const origin = await startServer()

    expect(firstId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
    expect(secondId).not.toBe(firstId)
    expect(await (await fetch(`${origin}/shared/${firstId}`)).text()).toBe(firstHtml)
    expect(await (await fetch(`${origin}/shared/${secondId}`)).text()).toBe(secondHtml)
    expect(await readSharedHtml(firstId)).toBe(firstHtml)

    const head = await fetch(`${origin}/shared/${firstId}`, { method: 'HEAD' })
    expect(head.status).toBe(200)
    expect(await head.text()).toBe('')
    expect(head.headers.get('content-security-policy')).toContain('sandbox')
    expect(head.headers.get('content-security-policy')).not.toContain('allow-same-origin')
  })

  it('rejects malformed and missing shared page IDs', async () => {
    const origin = await startServer()

    expect((await fetch(`${origin}/shared/not-a-uuid`)).status).toBe(404)
    expect((await fetch(`${origin}/shared/00000000-0000-4000-8000-000000000000`)).status).toBe(404)
    expect(await readSharedHtml('../hosted')).toBeNull()
    expect(sharedPageUrl('../hosted')).toBeNull()
  })

  it('builds shared page URLs from WEB_DOMAIN', () => {
    process.env.WEB_DOMAIN = 'pages.example.com/base'
    expect(sharedPageUrl('00000000-0000-4000-8000-000000000000')).toBe(
      'https://pages.example.com/shared/00000000-0000-4000-8000-000000000000'
    )
  })

  it('protects chat and exposes OIDC setup only until the first successful save', async () => {
    const origin = await startServer()
    const oidcSettings = {
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
    }

    const unauthorized = await fetch(`${origin}/api/chat/history`)
    expect(unauthorized.status).toBe(401)
    const unauthorizedInteraction = await fetch(`${origin}/api/chat/interaction`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ customId: 'gpt-action:token:button' })
    })
    expect(unauthorizedInteraction.status).toBe(401)
    const unauthorizedCancel = await fetch(`${origin}/api/chat/cancel`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionName: 'default' })
    })
    expect(unauthorizedCancel.status).toBe(401)

    const session = await fetch(`${origin}/api/session`)
    expect(await session.json()).toMatchObject({ oidcSetupRequired: true, oidcEnabled: false })

    const initialSettings = await fetch(`${origin}/api/admin/oidc`)
    expect(initialSettings.status).toBe(200)
    expect(await initialSettings.json()).toBeNull()

    const saved = await fetch(`${origin}/api/admin/oidc`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(oidcSettings)
    })
    const savedBody = (await saved.json()) as Record<string, unknown>
    expect(saved.status).toBe(200)
    expect(savedBody.hasClientSecret).toBe(true)
    expect(savedBody).not.toHaveProperty('clientSecret')

    const configuredSession = await fetch(`${origin}/api/session`)
    expect(await configuredSession.json()).toMatchObject({
      oidcSetupRequired: false,
      oidcEnabled: true
    })

    const loaded = await fetch(`${origin}/api/admin/oidc`)
    expect(loaded.status).toBe(401)
    expect(await loaded.text()).not.toContain('confidential-test-value')

    const secondSave = await fetch(`${origin}/api/admin/oidc`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: '{}'
    })
    expect(secondSave.status).toBe(401)

    const { cookie, csrfToken } = createWebSessionForTests({
      id: 'web:issuer:authenticated-subject',
      subject: 'authenticated-subject',
      name: 'Authenticated user',
      admin: false,
      allowed: false
    })
    const authenticatedLoad = await fetch(`${origin}/api/admin/oidc`, {
      headers: { Cookie: cookie }
    })
    const authenticatedSave = await fetch(`${origin}/api/admin/oidc`, {
      method: 'PUT',
      headers: {
        Cookie: cookie,
        'Content-Type': 'application/json',
        'X-CSRF-Token': csrfToken
      },
      body: JSON.stringify({ ...oidcSettings, clientSecret: '' })
    })

    expect(authenticatedLoad.status).toBe(200)
    expect(authenticatedSave.status).toBe(200)
  })

  it('never exposes global system prompt management without an authenticated session', async () => {
    const origin = await startServer()
    const options = {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt: 'Unauthorized replacement' })
    }

    const read = await fetch(`${origin}/api/admin/system-prompt`)
    const update = await fetch(`${origin}/api/admin/system-prompt`, options)
    const reset = await fetch(`${origin}/api/admin/system-prompt/reset`, { method: 'POST' })

    expect(read.status).toBe(401)
    expect(update.status).toBe(401)
    expect(reset.status).toBe(401)
    expect(getStoredValue('global-system-prompt')).toBeUndefined()
  })

  it('lets any authenticated user load, persist, and reset the global system prompt', async () => {
    const origin = await startServer()
    const { cookie, csrfToken } = createWebSessionForTests({
      id: 'web:issuer:authenticated-subject',
      subject: 'authenticated-subject',
      name: 'Authenticated user',
      admin: false,
      allowed: true
    })
    const authenticatedHeaders = { Cookie: cookie }
    const mutationHeaders = {
      ...authenticatedHeaders,
      'Content-Type': 'application/json',
      'X-CSRF-Token': csrfToken
    }

    const initial = await fetch(`${origin}/api/admin/system-prompt`, {
      headers: authenticatedHeaders
    })
    expect(initial.status).toBe(200)
    expect(await initial.json()).toMatchObject({ isDefault: true, updatedAt: null })

    const missingCsrf = await fetch(`${origin}/api/admin/system-prompt`, {
      method: 'PUT',
      headers: { ...authenticatedHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt: 'Unprotected replacement' })
    })
    expect(missingCsrf.status).toBe(403)

    const idleCancel = await fetch(`${origin}/api/chat/cancel`, {
      method: 'POST',
      headers: mutationHeaders,
      body: JSON.stringify({ sessionName: 'default' })
    })
    expect(idleCancel.status).toBe(200)
    expect(await idleCancel.json()).toEqual({ cancelled: false })

    const update = await fetch(`${origin}/api/admin/system-prompt`, {
      method: 'PUT',
      headers: mutationHeaders,
      body: JSON.stringify({ prompt: 'Answer with the important evidence first.' })
    })
    expect(update.status).toBe(200)
    expect(await update.json()).toMatchObject({
      prompt: 'Answer with the important evidence first.',
      isDefault: false,
      updatedBy: 'web:issuer:authenticated-subject'
    })
    expect(JSON.parse(getStoredValue('global-system-prompt')!)).toMatchObject({
      prompt: 'Answer with the important evidence first.'
    })

    const endpointUpdate = await fetch(`${origin}/api/admin/openai-endpoint`, {
      method: 'PUT',
      headers: mutationHeaders,
      body: JSON.stringify({ endpoint: 'https://inference.example.com/openai/v1/' })
    })
    expect(endpointUpdate.status).toBe(200)
    expect(await endpointUpdate.json()).toMatchObject({
      endpoint: 'https://inference.example.com/openai/v1',
      isDefault: false
    })
    expect(
      await (
        await fetch(`${origin}/api/admin/openai-endpoint`, { headers: authenticatedHeaders })
      ).json()
    ).toMatchObject({ endpoint: 'https://inference.example.com/openai/v1' })

    const endpointReset = await fetch(`${origin}/api/admin/openai-endpoint/reset`, {
      method: 'POST',
      headers: { ...authenticatedHeaders, 'X-CSRF-Token': csrfToken }
    })
    expect(await endpointReset.json()).toMatchObject({
      endpoint: 'https://api.openai.com/v1',
      isDefault: true
    })

    const tokenUpdate = await fetch(`${origin}/api/admin/openai-token`, {
      method: 'PUT',
      headers: mutationHeaders,
      body: JSON.stringify({ token: 'web-override-secret-token' })
    })
    const tokenSetting = (await tokenUpdate.json()) as Record<string, unknown>
    expect(tokenUpdate.status).toBe(200)
    expect(tokenSetting).toMatchObject({ hasOverride: true, effectiveSource: 'override' })
    expect(tokenSetting).not.toHaveProperty('token')
    expect(getStoredValue('openai-token')).not.toContain('web-override-secret-token')

    const loadedTokenSetting = await fetch(`${origin}/api/admin/openai-token`, {
      headers: authenticatedHeaders
    })
    expect(await loadedTokenSetting.json()).toMatchObject({
      hasOverride: true,
      effectiveSource: 'override'
    })

    const tokenReset = await fetch(`${origin}/api/admin/openai-token/reset`, {
      method: 'POST',
      headers: { ...authenticatedHeaders, 'X-CSRF-Token': csrfToken }
    })
    expect(await tokenReset.json()).toMatchObject({
      hasOverride: false,
      effectiveSource: 'missing'
    })

    const sessionPrompt = await fetch(`${origin}/api/chat/system-prompt`, {
      method: 'PUT',
      headers: mutationHeaders,
      body: JSON.stringify({
        sessionName: 'work',
        prompt: 'Use the terminology for this project.'
      })
    })
    expect(sessionPrompt.status).toBe(200)
    expect(await sessionPrompt.json()).toMatchObject({
      prompt: 'Use the terminology for this project.',
      isSet: true
    })

    const loadedSessionPrompt = await fetch(
      `${origin}/api/chat/system-prompt?session=${encodeURIComponent('work')}`,
      { headers: authenticatedHeaders }
    )
    expect(await loadedSessionPrompt.json()).toMatchObject({
      prompt: 'Use the terminology for this project.',
      isSet: true
    })

    const clearedSessionPrompt = await fetch(`${origin}/api/chat/system-prompt/reset`, {
      method: 'POST',
      headers: mutationHeaders,
      body: JSON.stringify({ sessionName: 'work' })
    })
    expect(await clearedSessionPrompt.json()).toEqual({
      prompt: '',
      isSet: false,
      updatedAt: null,
      updatedBy: null
    })

    const reset = await fetch(`${origin}/api/admin/system-prompt/reset`, {
      method: 'POST',
      headers: { ...authenticatedHeaders, 'X-CSRF-Token': csrfToken }
    })
    expect(reset.status).toBe(200)
    expect(await reset.json()).toMatchObject({
      isDefault: true,
      updatedBy: 'web:issuer:authenticated-subject'
    })
  })

  it('generates and reuses a persisted web session secret across restarts', async () => {
    const origin = await startServer()
    const generatedSecret = getStoredValue('web-session-secret')
    expect(generatedSecret).toMatch(/^[A-Za-z0-9_-]{43}$/)

    const saved = await fetch(`${origin}/api/admin/oidc`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        enabled: true,
        issuerUrl: 'https://identity.example.com',
        clientId: 'solver',
        clientSecret: 'confidential-test-value',
        redirectUri: 'https://solver.example.com/auth/callback',
        scopes: 'openid',
        allowedSubjects: '',
        adminSubjects: 'trusted-admin',
        automaticLogin: false,
        postLogoutRedirectUri: ''
      })
    })
    expect(saved.status).toBe(200)

    await closeWebServer(server!)
    server = undefined
    resetWebAuthForTests()
    const restartedOrigin = await startServer()

    expect(getStoredValue('web-session-secret')).toBe(generatedSecret)
    expect(await (await fetch(`${restartedOrigin}/api/session`)).json()).toMatchObject({
      oidcSetupRequired: false,
      oidcEnabled: true
    })
  })

  it('keeps an explicit WEB_SESSION_SECRET as the highest-priority key', async () => {
    setStoredValue(
      'web-session-secret',
      'different-persisted-secret-that-is-at-least-32-characters'
    )
    process.env.WEB_SESSION_SECRET = 'explicit-session-secret-that-is-at-least-32-characters'
    const origin = await startServer()

    const saved = await fetch(`${origin}/api/admin/oidc`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        enabled: true,
        issuerUrl: 'https://identity.example.com',
        clientId: 'solver',
        clientSecret: 'confidential-test-value',
        redirectUri: 'https://solver.example.com/auth/callback',
        scopes: 'openid',
        allowedSubjects: '',
        adminSubjects: 'trusted-admin',
        automaticLogin: false,
        postLogoutRedirectUri: ''
      })
    })

    expect(saved.status).toBe(200)
    expect(getStoredValue('web-session-secret')).toBe(
      'different-persisted-secret-that-is-at-least-32-characters'
    )
  })

  it('rejects a short explicit WEB_SESSION_SECRET before listening', async () => {
    process.env.WEB_SESSION_SECRET = 'too-short'
    await expect(startWebServer({ host: '127.0.0.1', port: 0 })).rejects.toThrow(
      'WEB_SESSION_SECRET must contain at least 32 characters'
    )
  })

  it('requires enabled OIDC for initial setup without requiring an administrator', async () => {
    const origin = await startServer()
    const settings = {
      enabled: false,
      issuerUrl: 'https://identity.example.com',
      clientId: 'solver',
      clientSecret: 'confidential-test-value',
      redirectUri: 'https://solver.example.com/auth/callback',
      scopes: 'openid',
      allowedSubjects: '',
      adminSubjects: '',
      automaticLogin: false,
      postLogoutRedirectUri: ''
    }

    const disabled = await fetch(`${origin}/api/admin/oidc`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(settings)
    })
    expect(disabled.status).toBe(400)
    expect(await disabled.json()).toEqual({ error: 'Initial OIDC setup must enable login' })

    const noAdministrator = await fetch(`${origin}/api/admin/oidc`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...settings, enabled: true })
    })
    expect(noAdministrator.status).toBe(200)

    expect(await (await fetch(`${origin}/api/session`)).json()).toMatchObject({
      oidcSetupRequired: false
    })
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
