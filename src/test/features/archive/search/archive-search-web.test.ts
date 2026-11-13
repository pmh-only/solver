import { join } from 'node:path'
import type { AddressInfo } from 'node:net'
import type { Server } from 'node:http'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createWebServer, closeWebServer } from '../../../../web/server.js'
import { createWebSessionForTests, resetWebAuthForTests } from '../../../../web/auth/session.js'
import {
  archiveWebChannel,
  searchDiscordArchiveForWeb
} from '../../../../features/archive/service.js'
import {
  ArchiveQueryError,
  prepareArchiveSearch as interpretArchiveSearch
} from '../../../../features/archive/search/query.js'
import { createArchiveWebSearch } from '../../../../features/archive/search/web.js'
import { clearStoredValues } from '../../../../shared/storage/kv-store.js'
import { isolateStoredValues } from '../../../support/kv-store.js'

vi.mock('../../../../features/archive/service.js', async (original) => ({
  ...(await original<typeof import('../../../../features/archive/service.js')>()),
  archiveWebChannel: vi.fn(),
  searchDiscordArchiveForWeb: vi.fn()
}))
vi.mock('../../../../features/archive/search/query.js', async (original) => ({
  ...(await original<typeof import('../../../../features/archive/search/query.js')>()),
  prepareArchiveSearch: vi.fn()
}))
let server: Server
let origin: string
let credentials: { cookie: string; csrfToken: string }
let userId: string
let counter = 0
const CHANNEL = { id: '777777777777777777', guildId: '333333333333333333', name: 'chat' }
const result = {
  channel: CHANNEL,
  matches: [
    {
      id: '1000000000000000100',
      authorName: '<script>user</script>',
      snippet: '털 [test]',
      field: 'content' as const,
      url: `https://discord.com/channels/${CHANNEL.guildId}/${CHANNEL.id}/1000000000000000100`
    }
  ],
  more: false,
  historyComplete: false,
  collection: { messageCount: 12345, historyCursorAt: '2026-10-01T00:00:00.000Z' },
  pendingEvents: 0
}
beforeEach(async () => {
  isolateStoredValues(join(process.cwd(), '.tmp', 'archive-search-web.test.sqlite'))
  clearStoredValues()
  resetWebAuthForTests()
  vi.resetAllMocks()
  userId = String(555555555555555555n + BigInt(counter++))
  credentials = createWebSessionForTests({
    id: 'oidc:member',
    subject: 'member',
    name: 'Member',
    discordId: userId,
    allowed: false,
    admin: false
  })
  vi.mocked(archiveWebChannel).mockResolvedValue(CHANNEL)
  vi.mocked(interpretArchiveSearch).mockResolvedValue({ keyword: '털', scope: 'content' })
  vi.mocked(searchDiscordArchiveForWeb).mockResolvedValue(result)
  server = createWebServer()
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})
afterEach(async () => {
  await closeWebServer(server)
  clearStoredValues()
  resetWebAuthForTests()
  vi.restoreAllMocks()
})
function search(
  body: unknown = { prompt: '본문에 털이 들어가는 글 찾아줘' },
  extra: Record<string, string> = {}
) {
  return fetch(`${origin}/api/archive-search`, {
    method: 'POST',
    headers: {
      Cookie: credentials.cookie,
      'X-CSRF-Token': credentials.csrfToken,
      'Content-Type': 'application/json',
      ...extra
    },
    body: JSON.stringify(body)
  })
}
describe('OIDC archive web search', () => {
  it('serves a responsive CSP-compatible shell with safe rendering and a login return path', async () => {
    const response = await fetch(`${origin}/search`)
    const html = await response.text()
    expect(response.status).toBe(200)
    expect(html).toContain('name="viewport"')
    expect(html).toContain('/auth/login?returnTo=%2Fsearch')
    expect(response.headers.get('content-security-policy')).toContain("script-src 'self'")
    const script = await (await fetch(`${origin}/search.js`)).text()
    expect(script).not.toContain('innerHTML')
    expect(script).toContain('snippet.textContent = item.snippet')
    expect(script).toContain('data.collection')
    expect(script).toContain('과거 기록 수집 미완료')
    expect(script).not.toContain('일부 결과가 빠질 수 있습니다')
    expect(script).not.toContain('실시간 반영을 기다리는 메시지가 있습니다')
    expect((await fetch(`${origin}/search.css`)).status).toBe(200)
    expect(await (await fetch(`${origin}/search`, { method: 'HEAD' })).text()).toBe('')
  })
  it('denies anonymous and non-linked sessions before querying Discord or the parser', async () => {
    expect((await fetch(`${origin}/api/archive-search/session`)).status).toBe(401)
    expect((await search(undefined, { Cookie: '' })).status).toBe(401)
    const unlinked = createWebSessionForTests({
      id: 'web:admin',
      subject: 'admin',
      name: 'Admin',
      admin: true,
      allowed: true
    })
    expect(
      (
        await fetch(`${origin}/api/archive-search/session`, {
          headers: { Cookie: unlinked.cookie }
        })
      ).status
    ).toBe(403)
    expect(archiveWebChannel).not.toHaveBeenCalled()
    expect(interpretArchiveSearch).not.toHaveBeenCalled()
  })
  it('lets linked ordinary users search without assistant allowlist, administrator or role privileges', async () => {
    const metadata = await fetch(`${origin}/api/archive-search/session`, {
      headers: { Cookie: credentials.cookie }
    })
    expect(metadata.status).toBe(200)
    expect(await metadata.json()).toMatchObject({
      channel: CHANNEL,
      csrfToken: credentials.csrfToken
    })
    const response = await search()
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({
      intent: { keyword: '털', scope: 'content' },
      collection: result.collection,
      matches: result.matches
    })
    expect(searchDiscordArchiveForWeb).toHaveBeenCalledWith(userId, {
      keyword: '털',
      scope: 'content'
    })
    expect(response.headers.get('cache-control')).toBe('no-store')
  })
  it('requires CSRF and rejects user/channel identity injection and oversized requests', async () => {
    expect((await search(undefined, { 'X-CSRF-Token': 'wrong' })).status).toBe(403)
    for (const body of [
      { prompt: '털', userId: '666666666666666666' },
      { prompt: '털', channelId: CHANNEL.id },
      { prompt: '' },
      { prompt: 'x'.repeat(4001) }
    ]) {
      expect((await search(body)).status).toBe(400)
    }
    expect(interpretArchiveSearch).not.toHaveBeenCalled()
  })
  it('checks current channel permissions before query processing and hides private channel metadata', async () => {
    vi.mocked(archiveWebChannel).mockRejectedValue(
      Object.assign(new Error('private channel details'), { status: 403 })
    )
    const response = await search()
    expect(response.status).toBe(403)
    expect(await response.text()).not.toContain('private channel details')
    expect(interpretArchiveSearch).not.toHaveBeenCalled()
  })
  it('handles invalid syntax, preparation failures and no results', async () => {
    vi.mocked(interpretArchiveSearch).mockRejectedValueOnce(
      new ArchiveQueryError('닫는 괄호가 필요합니다.')
    )
    const syntax = await search({ prompt: '(털 OR 고양이' })
    expect(syntax.status).toBe(400)
    expect(await syntax.text()).toContain('닫는 괄호')
    vi.mocked(interpretArchiveSearch).mockResolvedValueOnce(null)
    expect((await search()).status).toBe(400)
    expect(searchDiscordArchiveForWeb).not.toHaveBeenCalled()
    vi.mocked(interpretArchiveSearch).mockRejectedValueOnce(new Error('secret-provider-token'))
    const failed = await search()
    expect(failed.status).toBe(502)
    expect(await failed.text()).not.toContain('secret-provider-token')
    vi.mocked(searchDiscordArchiveForWeb).mockResolvedValueOnce({ ...result, matches: [] })
    expect((await search()).status).toBe(200)
  })
  it('limits query work per user and across concurrent requests', async () => {
    const run = createArchiveWebSearch()
    for (let i = 0; i < 6; i++) await run(userId, { prompt: '털' })
    await expect(run(userId, { prompt: '털' })).rejects.toMatchObject({ status: 429 })
    const another = createArchiveWebSearch()
    let resolve!: (intent: { keyword: string; scope: 'content' }) => void
    vi.mocked(interpretArchiveSearch).mockReturnValueOnce(
      new Promise((done) => {
        resolve = done
      })
    )
    const pending = another(userId, { prompt: '털' })
    await vi.waitFor(() => expect(interpretArchiveSearch).toHaveBeenCalledTimes(7))
    await expect(another('888888888888888888', { prompt: '털' })).rejects.toMatchObject({
      status: 429
    })
    resolve({ keyword: '털', scope: 'content' })
    await pending
  })
})
