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

let server: Server | undefined

afterEach(async () => {
  vi.restoreAllMocks()
  delete process.env.WEB_DOMAIN
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
  it('serves the responsive Hello World page', async () => {
    const origin = await startServer()
    const response = await fetch(`${origin}/`)
    const html = await response.text()

    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toBe('text/html; charset=utf-8')
    expect(response.headers.get('content-security-policy')).toContain('frame-ancestors')
    expect(html).toContain('<h1>Hello, World!</h1>')
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

  it('atomically publishes and serves one persistent HTML file', async () => {
    const html =
      '<!doctype html><html><body><script>document.body.dataset.ready="yes"</script></body></html>'
    await writeHostedHtml(html)
    const origin = await startServer()

    const response = await fetch(`${origin}/`)

    expect(response.status).toBe(200)
    expect(await response.text()).toBe(html)
    expect(response.headers.get('content-security-policy')).toBeNull()
    expect(await readFile(HOSTED_HTML_PATH, 'utf8')).toBe(html)
  })

  it('validates hosted HTML and normalizes WEB_DOMAIN', async () => {
    await expect(writeHostedHtml('')).rejects.toThrow('HTML must not be empty')
    await expect(writeHostedHtml('x'.repeat(MAX_HOSTED_HTML_BYTES + 1))).rejects.toThrow(
      'HTML must not exceed 1 MiB'
    )

    process.env.WEB_DOMAIN = 'pages.example.com'
    expect(hostedPageUrl()).toBe('https://pages.example.com')
    process.env.WEB_DOMAIN = 'http://localhost:3000'
    expect(hostedPageUrl()).toBe('http://localhost:3000')
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
