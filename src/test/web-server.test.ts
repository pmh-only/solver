import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AddressInfo } from 'node:net'
import type { Server } from 'node:http'
import { closeWebServer, startWebServer } from '../web-server.js'

let server: Server | undefined

afterEach(async () => {
  vi.restoreAllMocks()
  if (!server) return
  await closeWebServer(server)
  server = undefined
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
