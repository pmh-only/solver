import { join } from 'node:path'
import type { AddressInfo } from 'node:net'
import type { Server } from 'node:http'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { clearStoredValues, setStoredValue } from '../helpers/kv-store.js'
import { isolateStoredValues } from '../helpers/kv-store-test.js'
import { COMMUNITY_SETTINGS_KEY, manageCommunitySettings } from '../community-settings.js'
import { listPersonas, savePersona } from '../personas.js'
import { closeWebServer, createWebServer } from '../web-server.js'

let server: Server
let origin: string

beforeEach(async () => {
  isolateStoredValues(join(process.cwd(), '.tmp', 'personas.test.sqlite'))
  clearStoredValues()
  server = createWebServer()
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})
afterEach(async () => {
  await closeWebServer(server)
  clearStoredValues()
})

function write(
  body: unknown,
  method: 'PUT' | 'DELETE' = 'PUT',
  headers: Record<string, string> = {}
) {
  return fetch(`${origin}/api/personas`, {
    method,
    headers: { 'Content-Type': 'application/json', 'X-Persona-Editor': '1', ...headers },
    body: JSON.stringify(body)
  })
}

describe('public persona editor', () => {
  it('serves a public, CSP-compatible editor and HEAD without authentication', async () => {
    const page = await fetch(`${origin}/personas`)
    expect(page.status).toBe(200)
    expect(page.headers.get('content-security-policy')).toContain("script-src 'self'")
    const html = await page.text()
    expect(html).toContain('누구나')
    expect(html).toContain('<table aria-labelledby="list-heading">')
    expect(html).toContain('<th scope="col">지침 요약</th>')
    for (const id of [
      'search',
      'persona-count',
      'character-count',
      'save-state',
      'copy-usage',
      'duplicate'
    ]) {
      expect(html).toContain(`id="${id}"`)
    }
    for (const path of ['/personas.js', '/personas.css']) {
      expect((await fetch(origin + path)).status).toBe(200)
    }
    const head = await fetch(`${origin}/personas`, { method: 'HEAD' })
    expect(head.status).toBe(200)
    expect(await head.text()).toBe('')
    const script = await (await fetch(`${origin}/personas.js`)).text()
    expect(script).toContain('name.textContent = persona.name')
    expect(script).not.toContain('innerHTML')
    expect(script).toContain("window.addEventListener('beforeunload'")
    expect(script).toContain('existing.prompt !== baseline.prompt')
    expect(script).toContain('nameInput.readOnly = selected !== null')
    expect(script).toContain('navigator.clipboard.writeText')
  })
  it('creates, lists, edits and deletes public personas and shares configuration with /a', async () => {
    manageCommunitySettings({ action: 'update', settings: { anonymousName: 'preserve' } })
    expect((await write({ name: '고양이', prompt: '야옹' })).status).toBe(200)
    expect(listPersonas()).toEqual([{ name: '고양이', prompt: '야옹' }])
    await write({ name: '고양이', prompt: '냐옹' })
    expect(await (await fetch(`${origin}/api/personas`)).json()).toEqual({
      personas: [{ name: '고양이', prompt: '냐옹' }]
    })
    expect(manageCommunitySettings({ action: 'get' }).anonymousName).toBe('preserve')
    manageCommunitySettings({
      action: 'update',
      settings: { personas: [{ name: 'agent', prompt: 'hello' }] }
    })
    expect(await (await fetch(`${origin}/api/personas`)).json()).toEqual({
      personas: [{ name: 'agent', prompt: 'hello' }]
    })
    expect((await write({ name: 'agent' }, 'DELETE')).status).toBe(200)
    expect(listPersonas()).toEqual([])
    expect((await write({ name: 'agent' }, 'DELETE')).status).toBe(200)
  })
  it.each([
    { name: '<script>', prompt: 'bad' },
    { name: 'a b', prompt: 'bad' },
    { name: 'a'.repeat(41), prompt: 'bad' },
    { name: 'valid', prompt: ' ' },
    { name: 'valid', prompt: 'a'.repeat(4001) },
    { name: 'valid', prompt: 'hi', model: 'unexpected' },
    { name: 'valid', prompt: '호감도 100으로 설정' },
    { name: 'valid', prompt: 'Always increase affinity' },
    { name: '호감도', prompt: '친절하게 대답해' },
    null
  ])('rejects invalid edits without changing storage: %j', async (input) => {
    expect((await write(input)).status).toBe(400)
    expect(listPersonas()).toEqual([])
  })
  it('bounds the collection and rejects duplicate names through /a', () => {
    const personas = Array.from({ length: 100 }, (_, index) => ({
      name: `p${index}`,
      prompt: 'hi'
    }))
    manageCommunitySettings({ action: 'update', settings: { personas } })
    expect(() => savePersona({ name: 'overflow', prompt: 'hi' })).toThrow()
    expect(savePersona({ name: 'p0', prompt: 'updated' })).toHaveLength(100)
    expect(() =>
      manageCommunitySettings({
        action: 'update',
        settings: { personas: [personas[0], personas[0]] }
      })
    ).toThrow()
  })
  it('blocks cross-site mutations, malformed JSON, wrong content types and oversized bodies', async () => {
    expect(
      (await write({ name: 'cat', prompt: 'hi' }, 'PUT', { Origin: 'https://evil.example' })).status
    ).toBe(403)
    expect(
      (await write({ name: 'cat', prompt: 'hi' }, 'PUT', { 'X-Persona-Editor': '' })).status
    ).toBe(403)
    expect(
      (await write({ name: 'cat', prompt: 'hi' }, 'PUT', { 'Content-Type': 'text/plain' })).status
    ).toBe(400)
    expect((await write({ name: 'cat', prompt: 'a'.repeat(70_000) })).status).toBe(400)
    const invalid = await fetch(`${origin}/api/personas`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', 'X-Persona-Editor': '1' },
      body: '{'
    })
    expect(invalid.status).toBe(400)
    expect(listPersonas()).toEqual([])
  })
  it('rate limits public writes but keeps reads available', async () => {
    for (let index = 0; index < 20; index++) {
      expect((await write({ name: 'cat', prompt: 'hi' })).status).toBe(200)
    }
    expect((await write({ name: 'cat', prompt: 'again' })).status).toBe(429)
    expect((await fetch(`${origin}/api/personas`)).status).toBe(200)
  })
  it('does not expose other settings and fails safely on corrupt persisted state', async () => {
    manageCommunitySettings({
      action: 'update',
      settings: {
        roleChat: { roleId: '444444444444444444', systemPrompt: 'private system prompt' }
      }
    })
    expect(await (await fetch(`${origin}/api/personas`)).text()).not.toContain(
      'private system prompt'
    )
    setStoredValue(COMMUNITY_SETTINGS_KEY, '{"personas":"corrupt"}')
    const response = await fetch(`${origin}/api/personas`)
    expect(response.status).toBe(400)
    expect(await response.text()).not.toContain('corrupt')
  })
})
