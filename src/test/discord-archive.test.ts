import { mkdtemp, rm, truncate, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ChannelType, PermissionFlagsBits, type Client } from 'discord.js'
import { DiscordArchiveService } from '../discord-archive.js'
import { manageCommunitySettings } from '../community-settings.js'
import { clearStoredValues } from '../helpers/kv-store.js'
import { isolateStoredValues } from '../helpers/kv-store-test.js'

const USER = '666666666666666666'
const BOT = '999999999999999999'
const GUILD = '333333333333333333'
const CHANNEL = '777777777777777777'
const OTHER = '888888888888888888'
let directory: string
let service: DiscordArchiveService
const get = vi.fn()
const fetchChannel = vi.fn()
const fetchMember = vi.fn()
const permissions = vi.fn()

function message(id = '1000000000000000100', extra = {}) {
  return {
    id,
    channel_id: CHANNEL,
    author: { id: USER, username: 'alice', global_name: 'Alice', bot: false },
    content: 'Hello world',
    type: 0,
    timestamp: '2026-10-30T01:00:00Z',
    edited_timestamp: null,
    pinned: true,
    tts: false,
    flags: 0,
    attachments: [{ id: OTHER, filename: 'file.txt', url: 'https://cdn.example/file', size: 123 }],
    embeds: [{ title: 'An embed' }],
    mentions: [{ id: OTHER, username: 'bob' }],
    reactions: [{ count: 2, emoji: { name: '👍' } }],
    components: [{ type: 1, components: [] }],
    poll: { question: { text: 'Question' } },
    message_reference: { message_id: '1000000000000000001' },
    message_snapshots: [{ message: { content: 'forwarded text' } }],
    unknown_future_field: { value: 'preserved' },
    ...extra
  }
}
function channel(id = CHANNEL) {
  return {
    id,
    name: 'general',
    guild: { id: GUILD, members: { fetch: fetchMember } },
    messages: {},
    isTextBased: () => true,
    isThread: () => false,
    permissionsFor: permissions
  }
}
const call = (input: Record<string, unknown>, signal?: AbortSignal) =>
  service.run({ channelId: CHANNEL, ...input }, USER, signal)
async function collectOne() {
  get.mockResolvedValueOnce([message()]).mockResolvedValueOnce([])
  return call({ action: 'collect' })
}

beforeEach(async () => {
  isolateStoredValues(join(process.cwd(), '.tmp', 'discord-archive.test.sqlite'))
  clearStoredValues()
  directory = await mkdtemp(join(process.cwd(), '.tmp', 'discord-archive-'))
  vi.resetAllMocks()
  fetchChannel.mockResolvedValue(channel())
  fetchMember.mockImplementation(async (id: string) => ({ id }))
  permissions.mockReturnValue({ has: () => true })
  service = new DiscordArchiveService(
    { user: { id: BOT }, channels: { fetch: fetchChannel }, rest: { get } } as unknown as Client,
    directory
  )
})
afterEach(async () => {
  await rm(directory, { force: true, recursive: true })
  clearStoredValues()
})

describe('Discord DuckDB archive', () => {
  it('paginates and resumes across service restarts without duplicates, then queries normalized and complete JSON data', async () => {
    get.mockResolvedValueOnce([message(), message('1000000000000000099')])
    const partial = await call({ action: 'collect', maxPages: 1 })
    expect(partial).toMatchObject({
      message_count: 2,
      cursor: '1000000000000000099',
      complete: false,
      resumable: true
    })
    service = new DiscordArchiveService(
      { user: { id: BOT }, channels: { fetch: fetchChannel }, rest: { get } } as unknown as Client,
      directory
    )
    get.mockResolvedValueOnce([message('1000000000000000098')]).mockResolvedValueOnce([])
    expect(await call({ action: 'collect' })).toMatchObject({
      message_count: 3,
      complete: true,
      resumable: false
    })
    expect(get.mock.calls[1]![1].query.get('before')).toBe('1000000000000000099')
    const result = await call({
      action: 'query',
      sql: 'SELECT author_id, count(*)::INTEGER AS total FROM messages GROUP BY author_id'
    })
    expect(result).toMatchObject({ rows: [{ author_id: USER, total: 3 }], truncated: false })
    const raw = (await call({
      action: 'query',
      sql: `SELECT raw_json FROM messages WHERE message_id='1000000000000000100'`
    })) as { rows: { raw_json: string }[] }
    expect(JSON.parse(raw.rows[0]!.raw_json)).toEqual(message())
    const json = await call({
      action: 'query',
      sql: "SELECT json_extract_string(raw_json, '$.poll.question.text') AS question, json_extract_string(raw_json, '$.unknown_future_field.value') AS extra FROM messages LIMIT 1"
    })
    expect(json).toMatchObject({ rows: [{ question: 'Question', extra: 'preserved' }] })
    expect(await call({ action: 'query', sql: 'SELECT version() AS version' })).toMatchObject({
      rows: [{ version: expect.stringMatching(/^v?2\./) }]
    })
  })

  it('refreshes edits and new messages by upserting while preserving previous rows', async () => {
    await collectOne()
    get
      .mockResolvedValueOnce([
        message('1000000000000000101'),
        message('1000000000000000100', {
          content: 'edited',
          edited_timestamp: '2026-10-30T02:00:00Z'
        })
      ])
      .mockResolvedValueOnce([])
    expect(await call({ action: 'collect', restart: true })).toMatchObject({
      message_count: 2,
      complete: true
    })
    expect(
      await call({
        action: 'query',
        sql: "SELECT content FROM messages WHERE message_id='1000000000000000100'"
      })
    ).toMatchObject({ rows: [{ content: 'edited' }] })
  })

  it('preserves committed pages after API failure or cancellation and resumes from the last cursor', async () => {
    get.mockResolvedValueOnce([message()]).mockRejectedValueOnce(new Error('secret-token'))
    const interrupted = await call({ action: 'collect' })
    expect(interrupted).toMatchObject({
      message_count: 1,
      complete: false,
      resumable: true,
      issue: expect.stringContaining('preserved')
    })
    expect(JSON.stringify(interrupted)).not.toContain('secret-token')
    get.mockResolvedValueOnce([])
    expect(await call({ action: 'collect' })).toMatchObject({ complete: true, message_count: 1 })
    const controller = new AbortController()
    controller.abort()
    await expect(call({ action: 'query', sql: 'SELECT 1' }, controller.signal)).rejects.toThrow()
  })

  it.each([
    [message('1000000000000000100', { channel_id: OTHER })],
    [message('bad-id')],
    [message('1000000000000000100', { author: null })],
    { unexpected: true }
  ])('rejects malformed history without skipping data: %j', async (page) => {
    get.mockResolvedValueOnce(page)
    expect(await call({ action: 'collect' })).toMatchObject({
      message_count: 0,
      cursor: null,
      complete: false,
      issue: expect.stringContaining('Discord returned')
    })
  })

  it('detects non-advancing pages and strips credential fields without changing message content', async () => {
    get
      .mockResolvedValueOnce([
        message('1000000000000000100', {
          content: 'token is a word',
          token: 'sensitive',
          metadata: { authorization: 'sensitive' }
        })
      ])
      .mockResolvedValueOnce([message()])
    expect(await call({ action: 'collect' })).toMatchObject({
      message_count: 1,
      issue: expect.stringContaining('non-advancing')
    })
    const raw = (await call({ action: 'query', sql: 'SELECT raw_json FROM messages' })) as {
      rows: { raw_json: string }[]
    }
    expect(raw.rows[0]!.raw_json).not.toContain('sensitive')
    expect(JSON.parse(raw.rows[0]!.raw_json).content).toBe('token is a word')
  })

  it('requires administrator identity and current channel permissions for both requester and bot', async () => {
    await expect(service.run({ action: 'collect', channelId: CHANNEL }, OTHER)).rejects.toThrow(
      'administrator'
    )
    expect(fetchChannel).not.toHaveBeenCalled()
    permissions.mockReturnValue({ has: () => false })
    await expect(call({ action: 'collect' })).rejects.toThrow('Both requester and bot')
    expect(get).not.toHaveBeenCalled()
    permissions.mockReturnValue({ has: () => true })
    await collectOne()
    permissions.mockImplementation((member: { id: string }) => ({ has: () => member.id !== USER }))
    await expect(call({ action: 'query', sql: 'SELECT * FROM messages' })).rejects.toThrow(
      'Both requester and bot'
    )
  })

  it('requires private-thread membership when the requester cannot manage threads', async () => {
    const threadFetch = vi.fn().mockRejectedValue(new Error('not a member'))
    fetchChannel.mockResolvedValue({
      ...channel(),
      isThread: () => true,
      type: ChannelType.PrivateThread,
      members: { fetch: threadFetch }
    })
    permissions.mockReturnValue({
      has: (value: unknown) => value !== PermissionFlagsBits.ManageThreads
    })
    await expect(call({ action: 'collect' })).rejects.toThrow('private-thread members')
    expect(get).not.toHaveBeenCalled()
  })

  it('enforces the global storage budget before requesting Discord history', async () => {
    manageCommunitySettings({
      action: 'update',
      settings: { discordArchive: { maxStorageMiB: 64 } }
    })
    const path = join(directory, `${OTHER}.duckdb`)
    await writeFile(path, '')
    await truncate(path, 64 * 1024 * 1024)
    await expect(call({ action: 'collect' })).rejects.toThrow('storage limit')
    expect(get).not.toHaveBeenCalled()
  })

  it('rejects DMs, categories and forum parents and does not create missing archives for queries', async () => {
    fetchChannel.mockResolvedValueOnce({ isTextBased: () => true, messages: {} })
    await expect(call({ action: 'collect' })).rejects.toThrow('guild text channel')
    fetchChannel.mockResolvedValueOnce({ isTextBased: () => false, guild: {} })
    await expect(call({ action: 'collect' })).rejects.toThrow('guild text channel')
    await expect(call({ action: 'query', sql: 'SELECT 1' })).rejects.toThrow(
      'collect this channel first'
    )
  })

  it.each([
    'DELETE FROM messages',
    'DROP TABLE messages',
    'SELECT 1; SELECT 2',
    'SET enable_external_access=true',
    'INSTALL httpfs',
    "ATTACH ':memory:' AS other",
    "COPY messages TO '/tmp/should-not-exist.csv'",
    'CREATE TABLE surprise(i INTEGER)'
  ])('rejects writes, multiple statements and configuration escape attempts: %s', async (sql) => {
    await collectOne()
    await expect(call({ action: 'query', sql })).rejects.toThrow()
    expect(await call({ action: 'status' })).toMatchObject({ message_count: 1 })
  })

  it('blocks local filesystem SQL reads', async () => {
    await collectOne()
    const privateFile = join(directory, 'private.txt')
    await writeFile(privateFile, 'private fixture')
    await expect(
      call({ action: 'query', sql: `SELECT * FROM read_text('${privateFile}')` })
    ).rejects.toThrow()
  })

  it('bounds rows, cells and output bytes and supports cancelling an expensive query', async () => {
    await collectOne()
    expect(
      await call({ action: 'query', sql: 'SELECT * FROM range(1000)', rowLimit: 2 })
    ).toMatchObject({ returnedRows: 2, truncated: true })
    const result = await call({
      action: 'query',
      sql: "SELECT repeat('x', 10000) AS text FROM range(200)",
      rowLimit: 200
    })
    expect(result).toMatchObject({ truncated: true })
    expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThan(50 * 1024)
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 25)
    try {
      await expect(
        call(
          { action: 'query', sql: 'SELECT sum(i) FROM range(1000000000000) t(i)' },
          controller.signal
        )
      ).rejects.toThrow()
    } finally {
      clearTimeout(timer)
    }
  })

  it('configures limits and disablement through /a and allows explicit deletion while disabled', async () => {
    manageCommunitySettings({ action: 'update', settings: { discordArchive: { maxChannels: 1 } } })
    await collectOne()
    fetchChannel.mockResolvedValue(channel(OTHER))
    await expect(call({ action: 'collect', channelId: OTHER })).rejects.toThrow('channel limit')
    fetchChannel.mockResolvedValue(channel())
    manageCommunitySettings({ action: 'update', settings: { discordArchive: { enabled: false } } })
    await expect(call({ action: 'status' })).rejects.toThrow('disabled')
    expect(await call({ action: 'delete' })).toMatchObject({ deleted: true })
    manageCommunitySettings({ action: 'update', settings: { discordArchive: { enabled: true } } })
    await expect(call({ action: 'status' })).rejects.toThrow('collect this channel first')
  })

  it('rejects overlapping operations instead of racing DuckDB writers', async () => {
    let release!: () => void
    fetchChannel.mockReturnValueOnce(
      new Promise((resolve) => {
        release = () => resolve(channel())
      })
    )
    const first = call({ action: 'collect' })
    await expect(call({ action: 'status' })).rejects.toThrow('busy')
    get.mockResolvedValueOnce([])
    release()
    await first
  })
})
