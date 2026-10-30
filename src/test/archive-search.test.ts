import { join } from 'node:path'
import { Collection, MessageFlags, type Message } from 'discord.js'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createArchiveSearchHandler } from '../archive-search.js'
import { interpretArchiveSearch } from '../archive-search-ai.js'
import { createMessageHandler } from '../message-handler.js'
import { manageCommunitySettings } from '../community-settings.js'
import { clearStoredValues, setStoredValue } from '../helpers/kv-store.js'
import { isolateStoredValues } from '../helpers/kv-store-test.js'
import type { ArchiveSearchRequest, ArchiveSearchResult } from '../discord-archive.js'
import { clearRuntimeIssuesForTests, runtimeIssueSummary } from '../runtime-health.js'

const ROLE = '444444444444444444'
vi.mock('../archive-search-ai.js', () => ({ interpretArchiveSearch: vi.fn() }))
const USER = '555555555555555555'
const GUILD = '333333333333333333'
const CHANNEL = '777777777777777777'
const search = vi.fn<(input: ArchiveSearchRequest) => Promise<ArchiveSearchResult>>()
function message(overrides: Record<string, unknown> = {}) {
  return {
    id: '1000000000000000200',
    guildId: GUILD,
    channelId: CHANNEL,
    author: { id: USER, bot: false },
    webhookId: null,
    system: false,
    content: `<&@${ROLE}> 임베드나 컨텐츠에 "바나나" 들어가는 내용 있으면 찾아줘`,
    member: { roles: { cache: new Collection() } },
    channel: { sendTyping: vi.fn().mockResolvedValue(undefined) },
    reply: vi.fn().mockResolvedValue(undefined),
    ...overrides
  } as unknown as Message
}
beforeEach(() => {
  isolateStoredValues(join(process.cwd(), '.tmp', 'archive-search.test.sqlite'))
  clearStoredValues()
  clearRuntimeIssuesForTests()
  vi.resetAllMocks()
  vi.mocked(interpretArchiveSearch).mockResolvedValue({ keyword: '바나나', scope: 'all' })
  manageCommunitySettings({
    action: 'update',
    settings: { discordArchive: { searchRoleId: ROLE } }
  })
  search.mockResolvedValue({
    matches: [
      {
        id: '1000000000000000100',
        authorName: 'author',
        snippet: '바나나 관련 내용',
        field: 'embeds'
      }
    ],
    more: false,
    historyComplete: true,
    pendingEvents: 0
  })
})
afterEach(() => {
  vi.restoreAllMocks()
  clearStoredValues()
  clearRuntimeIssuesForTests()
})

describe('public archive role search', () => {
  it.each([
    [
      new Error('Binder Error: Table messages does not have a column named deleted_at'),
      '아카이브 형식'
    ],
    [
      new Error('Could not verify current search results', {
        cause: Object.assign(new Error('private response body'), { status: 403 })
      }),
      '권한'
    ],
    [new Error('operation timed out'), '시간이 초과']
  ])(
    'reports actionable query failures without disclosing raw details',
    async (error, expected) => {
      search.mockRejectedValueOnce(error)
      const input = message()
      await createArchiveSearchHandler(search)(input)
      const payload = vi.mocked(input.reply).mock.calls[0]![0] as { content: string }
      expect(payload.content).toContain(expected)
      expect(payload.content).not.toContain(error.message)
      expect(runtimeIssueSummary()).toContain('stage=search')
      expect(runtimeIssueSummary()).not.toContain('private response body')
    }
  )
  it('passes unquoted natural language to AI and searches only its validated intent', async () => {
    vi.mocked(interpretArchiveSearch).mockResolvedValueOnce({ keyword: '털', scope: 'content' })
    await createArchiveSearchHandler(search)(
      message({ content: `<@&${ROLE}> 본문에 털이 들어가는 글 찾아줘` })
    )
    expect(interpretArchiveSearch).toHaveBeenCalledWith('본문에 털이 들어가는 글 찾아줘')
    expect(search).toHaveBeenCalledWith(
      expect.objectContaining({ keyword: '털', scope: 'content' })
    )
  })
  it('does not search when AI fails and releases concurrency for the next request', async () => {
    vi.mocked(interpretArchiveSearch).mockRejectedValueOnce(new Error('private-api-detail'))
    const handle = createArchiveSearchHandler(search)
    const input = message()
    await handle(input)
    expect(search).not.toHaveBeenCalled()
    expect(JSON.stringify(vi.mocked(input.reply).mock.calls)).not.toContain('private-api-detail')
    await handle(message())
    expect(search).toHaveBeenCalledOnce()
  })
  it.each([`<&@${ROLE}>`, `<@&${ROLE}>`])(
    'allows non-administrators without the role to invoke %s',
    async (mention) => {
      const input = message({
        content: `${mention} 임베드나 컨텐츠에 "바나나" 들어가는 내용 찾아줘`
      })
      expect(process.env.ADMIN_USER_IDS).not.toContain(USER)
      await createArchiveSearchHandler(search)(input)
      expect(search).toHaveBeenCalledWith({
        guildId: GUILD,
        channelId: CHANNEL,
        userId: USER,
        requestMessageId: input.id,
        keyword: '바나나',
        scope: 'all'
      })
      expect(input.reply).toHaveBeenCalledWith({
        content: expect.stringContaining(
          `https://discord.com/channels/${GUILD}/${CHANNEL}/1000000000000000100`
        ),
        allowedMentions: { parse: [], repliedUser: false },
        flags: MessageFlags.SuppressEmbeds
      })
    }
  )
  it.each([
    { guildId: null },
    { author: { id: USER, bot: true } },
    { webhookId: 'webhook' },
    { system: true },
    { content: '바나나' },
    { content: `<@&${USER}> "바나나"` }
  ])('ignores unrelated or unsupported messages %j', async (overrides) => {
    const input = message(overrides)
    expect(await createArchiveSearchHandler(search)(input)).toBe(false)
    expect(search).not.toHaveBeenCalled()
    expect(input.reply).not.toHaveBeenCalled()
  })
  it('applies configuration updates and disablement immediately and fails closed on corrupt settings', async () => {
    const handle = createArchiveSearchHandler(search)
    manageCommunitySettings({
      action: 'update',
      settings: { discordArchive: { searchRoleId: null } }
    })
    expect(await handle(message())).toBe(false)
    setStoredValue('community:settings', 'broken')
    expect(await handle(message())).toBe(false)
    expect(search).not.toHaveBeenCalled()
  })
  it('claims invalid search requests and returns usage without invoking role chat or the database', async () => {
    vi.mocked(interpretArchiveSearch).mockResolvedValueOnce(null)
    const commands = vi.fn().mockResolvedValue(false)
    const chat = vi.fn().mockResolvedValue(undefined)
    const handle = createMessageHandler(commands, chat, createArchiveSearchHandler(search))
    const input = message({ content: `<@&${ROLE}> 찾아줘` })
    await handle(input)
    expect(input.reply).toHaveBeenCalled()
    expect(chat).not.toHaveBeenCalled()
    expect(search).not.toHaveBeenCalled()
  })
  it('routes commands first, search before role chat, and keeps ordinary chat unchanged', async () => {
    const commands = vi.fn().mockResolvedValue(false)
    const chat = vi.fn().mockResolvedValue(undefined)
    const handle = createMessageHandler(commands, chat, createArchiveSearchHandler(search))
    await handle(message())
    expect(search).toHaveBeenCalledOnce()
    expect(chat).not.toHaveBeenCalled()
    await handle(message({ content: 'ordinary chat' }))
    expect(chat).toHaveBeenCalledOnce()
    commands.mockResolvedValueOnce(true)
    await handle(message())
    expect(search).toHaveBeenCalledOnce()
  })
  it('bounds replies, prevents mentions and escapes source formatting', async () => {
    search.mockResolvedValue({
      matches: Array.from({ length: 100 }, (_, i) => ({
        id: String(1000000000000000000n + BigInt(i)),
        authorName: '@everyone **spoof**',
        snippet: '[fake](https://evil.example) @everyone ' + '한'.repeat(10000),
        field: 'content' as const
      })),
      more: true,
      historyComplete: false,
      pendingEvents: 1
    })
    const input = message()
    await createArchiveSearchHandler(search)(input)
    const payload = vi.mocked(input.reply).mock.calls[0]![0] as { content: string }
    expect(payload.content.length).toBeLessThanOrEqual(2000)
    expect((payload.content.match(/\[원문\]/g) ?? []).length).toBeLessThanOrEqual(5)
    expect(payload.content).not.toContain('@everyone')
    expect(payload.content).not.toContain('[fake](https://evil.example)')
    expect(payload.content).toContain('과거 기록 수집이 완료되지 않아')
  })
  it('rate limits repeated requests without flooding repeated rate notices', async () => {
    const handle = createArchiveSearchHandler(search)
    const inputs = Array.from({ length: 8 }, () => message())
    for (const input of inputs) await handle(input)
    expect(search).toHaveBeenCalledTimes(3)
    expect(inputs.filter((input) => vi.mocked(input.reply).mock.calls.length)).toHaveLength(4)
  })
  it('bounds concurrent work and releases it after failure', async () => {
    let reject!: (error: Error) => void
    search.mockReturnValueOnce(
      new Promise((_, no) => {
        reject = no
      })
    )
    const handle = createArchiveSearchHandler(search)
    const first = handle(message())
    await vi.waitFor(() => expect(search).toHaveBeenCalledOnce())
    const second = message({ author: { id: '888888888888888888', bot: false } })
    await handle(second)
    expect(second.reply).toHaveBeenCalledWith(
      expect.objectContaining({ content: expect.stringContaining('다른 검색') })
    )
    reject(new Error('secret-token'))
    await first
    const next = message({ author: { id: '888888888888888888', bot: false } })
    await handle(next)
    expect(search).toHaveBeenCalledTimes(2)
  })
})
