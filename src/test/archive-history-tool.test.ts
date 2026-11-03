import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createArchiveHistorySearch } from '../archive-history-tool.js'
import { searchDiscordHistory } from '../discord-archive.js'
import { manageCommunitySettings } from '../community-settings.js'
import { clearStoredValues, isInternalStoredKey, listStoredKeys } from '../helpers/kv-store.js'
import { isolateStoredValues } from '../helpers/kv-store-test.js'
import { clearRuntimeIssuesForTests, runtimeIssueSummary } from '../runtime-health.js'
vi.mock('../discord-archive.js', () => ({ searchDiscordHistory: vi.fn() }))
const context = {
  guildId: '333333333333333333',
  channelId: '777777777777777777',
  userId: '555555555555555555',
  requestMessageId: '1000000000000000100'
}
const query = { sql: "SELECT message_id FROM messages WHERE content ILIKE '%피자%'" }
const signal = () => new AbortController().signal
beforeEach(() => {
  isolateStoredValues(join(process.cwd(), '.tmp', 'archive-history-tool.test.sqlite'))
  clearStoredValues()
  clearRuntimeIssuesForTests()
  vi.resetAllMocks()
  manageCommunitySettings({
    action: 'update',
    settings: { roleChat: { roleId: '444444444444444444' } }
  })
  vi.mocked(searchDiscordHistory).mockResolvedValue({
    messages: [],
    historyComplete: true,
    more: false,
    pendingEvents: 0,
    note: 'untrusted'
  })
})
afterEach(() => {
  clearStoredValues()
  clearRuntimeIssuesForTests()
})
describe('scoped history search tool', () => {
  it('binds trusted identity and scope and allows at most two searches per reply', async () => {
    const search = createArchiveHistorySearch(context, true)
    for (let i = 0; i < 2; i++)
      expect(JSON.parse(await search(query, signal()))).toMatchObject({ messages: [] })
    expect(searchDiscordHistory).toHaveBeenCalledWith(context, query, expect.any(AbortSignal))
    expect(JSON.parse(await search(query, signal())).error).toContain('limit')
    expect(searchDiscordHistory).toHaveBeenCalledTimes(2)
    expect(listStoredKeys().every(isInternalStoredKey)).toBe(true)
  })
  it('rejects model-supplied scope/identity and oversized SQL before querying', async () => {
    for (const input of [
      { ...query, userId: context.userId },
      { ...query, channelId: context.channelId },
      { sql: 'x'.repeat(4001) }
    ]) {
      expect(
        JSON.parse(await createArchiveHistorySearch(context)(input, signal())).error
      ).toContain('Supply only')
    }
    expect(searchDiscordHistory).not.toHaveBeenCalled()
  })
  it('honors immediate /a disablement of role-chat history searches', async () => {
    const search = createArchiveHistorySearch(context, true)
    manageCommunitySettings({
      action: 'update',
      settings: { roleChat: { roleId: '444444444444444444', archiveSearch: false } }
    })
    expect(JSON.parse(await search(query, signal())).error).toContain('disabled')
    expect(searchDiscordHistory).not.toHaveBeenCalled()
  })
  it('bounds global search work with a fixed internal rate-limit keyspace', async () => {
    for (let i = 0; i < 30; i++) await createArchiveHistorySearch(context)(query, signal())
    expect(JSON.parse(await createArchiveHistorySearch(context)(query, signal())).error).toContain(
      'rate limited'
    )
    expect(searchDiscordHistory).toHaveBeenCalledTimes(30)
    expect(listStoredKeys().filter((key) => key.includes('sql-rate'))).toHaveLength(2)
  })
  it('redacts external errors and stops cancelled requests before the service call', async () => {
    vi.mocked(searchDiscordHistory).mockRejectedValueOnce(new Error('private-message-secret-token'))
    const result = await createArchiveHistorySearch(context)(query, signal())
    expect(result).toContain('Do not invent')
    expect(result + runtimeIssueSummary()).not.toContain('private-message-secret-token')
    const controller = new AbortController()
    controller.abort()
    await createArchiveHistorySearch(context)(query, controller.signal)
    expect(searchDiscordHistory).toHaveBeenCalledOnce()
  })
})
