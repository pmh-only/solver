import { mkdtemp, rm, truncate, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { EventEmitter } from 'node:events'
import { DatabaseSync } from 'node:sqlite'
import { DuckDBInstance } from '@duckdb/node-api'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ChannelType, Events, PermissionFlagsBits, type Client } from 'discord.js'
import {
  closeDiscordArchive,
  DiscordArchiveService,
  setDiscordArchiveClient
} from '../discord-archive.js'
import { manageCommunitySettings } from '../community-settings.js'
import { clearStoredValues } from '../helpers/kv-store.js'
import { isolateStoredValues } from '../helpers/kv-store-test.js'
import { clearRuntimeIssuesForTests } from '../runtime-health.js'

const USER = '666666666666666666'
const BOT = '999999999999999999'
const GUILD = '333333333333333333'
const CHANNEL = '777777777777777777'
const OTHER = '888888888888888888'
const SEARCH_ROLE = '444444444444444444'
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
  clearRuntimeIssuesForTests()
  directory = await mkdtemp(join(process.cwd(), '.tmp', 'discord-archive-'))
  vi.resetAllMocks()
  fetchChannel.mockResolvedValue(channel())
  fetchMember.mockImplementation(async (id: string) => ({ id }))
  permissions.mockReturnValue({ has: () => true })
  service = new DiscordArchiveService(
    { user: { id: BOT }, channels: { fetch: fetchChannel }, rest: { get } } as unknown as Client,
    directory,
    false
  )
})
afterEach(async () => {
  await closeDiscordArchive()
  await service.close()
  vi.restoreAllMocks()
  await rm(directory, { force: true, recursive: true })
  clearStoredValues()
  clearRuntimeIssuesForTests()
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
    await service.close()
    service = new DiscordArchiveService(
      { user: { id: BOT }, channels: { fetch: fetchChannel }, rest: { get } } as unknown as Client,
      directory,
      false
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
    })) as unknown as { rows: { raw_json: string }[] }
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
    const raw = (await call({
      action: 'query',
      sql: 'SELECT raw_json FROM messages'
    })) as unknown as {
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

function packet(type: string, data: Record<string, unknown>, sequence = 1) {
  return { t: type, s: sequence, d: { channel_id: CHANNEL, guild_id: GUILD, ...data } }
}
function queueContents() {
  const db = new DatabaseSync(join(directory, 'realtime-outbox.sqlite'), { readOnly: true })
  try {
    return db.prepare('SELECT id, payload FROM events').all() as { id: string; payload: string }[]
  } finally {
    db.close()
  }
}
function queueKeys() {
  return queueContents().map((item) => item.id)
}
async function rows(sql: string) {
  const result = await call({ action: 'query', sql })
  if (!('rows' in result) || !Array.isArray(result.rows)) throw new Error('Expected query rows')
  return result.rows as Record<string, unknown>[]
}

describe('realtime Discord archives', () => {
  it('migrates existing snapshot databases without deleting history or resetting pagination', async () => {
    const db = await DuckDBInstance.create(join(directory, `${CHANNEL}.duckdb`))
    const connection = await db.connect()
    try {
      await connection.run(`CREATE TABLE messages (
        message_id VARCHAR PRIMARY KEY, guild_id VARCHAR NOT NULL, channel_id VARCHAR NOT NULL,
        author_id VARCHAR NOT NULL, author_username VARCHAR, author_global_name VARCHAR,
        author_bot BOOLEAN, content VARCHAR, message_type INTEGER, created_at TIMESTAMPTZ,
        edited_at TIMESTAMPTZ, pinned BOOLEAN, tts BOOLEAN, flags UBIGINT, reply_to_id VARCHAR,
        attachments_count INTEGER, embeds_count INTEGER, raw_json JSON, collected_at TIMESTAMPTZ DEFAULT current_timestamp
      )`)
      await connection.run(
        'INSERT INTO messages(message_id,guild_id,channel_id,author_id,content,created_at,message_type,raw_json) VALUES (?,?,?,?,?,?::TIMESTAMPTZ,0,?::JSON)',
        [
          '1000000000000000100',
          GUILD,
          CHANNEL,
          USER,
          'Hello world',
          '2026-10-30T01:00:00Z',
          JSON.stringify(message())
        ]
      )
      await connection.run(
        `CREATE TABLE archive_state(id INTEGER PRIMARY KEY, guild_id VARCHAR, channel_id VARCHAR, channel_name VARCHAR, cursor VARCHAR, complete BOOLEAN, started_at TIMESTAMPTZ DEFAULT current_timestamp, updated_at TIMESTAMPTZ DEFAULT current_timestamp)`
      )
      await connection.run(
        'INSERT INTO archive_state(id,guild_id,channel_id,channel_name,cursor,complete) VALUES (1,?,?,?,?,true)',
        [GUILD, CHANNEL, 'general', '1000000000000000100']
      )
    } finally {
      connection.closeSync()
      db.closeSync()
    }
    expect(await call({ action: 'watch' })).toMatchObject({
      complete: true,
      cursor: '1000000000000000100',
      message_count: 1,
      realtime_enabled: true
    })
    service.handleGatewayPacket(packet('MESSAGE_DELETE', { id: '1000000000000000100' }))
    await service.flushRealtime()
    expect(await rows('SELECT content, deleted_at IS NOT NULL AS deleted FROM messages')).toEqual([
      { content: 'Hello world', deleted: true }
    ])
  })

  it('automatically enrolls collected channels and ingests all authors without duplicate event writes', async () => {
    await collectOne()
    expect(await call({ action: 'status' })).toMatchObject({ realtime_enabled: true })
    const event = packet(
      'MESSAGE_CREATE',
      message('1000000000000000101', {
        author: { id: BOT, username: 'bot', bot: true },
        metadata: { token: 'do-not-store' }
      })
    )
    expect(service.handleGatewayPacket(event)).toBe(true)
    expect(service.handleGatewayPacket(event)).toBe(true)
    expect(queueKeys()).toHaveLength(1)
    expect(queueContents()[0]!.payload).not.toContain('do-not-store')
    expect(await service.flushRealtime()).toBe(1)
    expect(
      (
        await rows(
          "SELECT author_bot, content, last_gateway_at IS NOT NULL AS live FROM messages WHERE message_id='1000000000000000101'"
        )
      )[0]
    ).toEqual({ author_bot: true, content: 'Hello world', live: true })
    service.handleGatewayPacket(event)
    await service.flushRealtime()
    expect(await rows('SELECT count(*)::INTEGER AS total FROM message_events')).toEqual([
      { total: 1 }
    ])
  })

  it('merges partial edits without losing existing metadata and prevents stale backfill from reverting edits', async () => {
    await collectOne()
    service.handleGatewayPacket(
      packet('MESSAGE_UPDATE', {
        id: '1000000000000000100',
        content: 'edited live',
        edited_timestamp: '2026-10-30T02:00:00Z'
      })
    )
    await service.flushRealtime()
    const data = JSON.parse(String((await rows('SELECT raw_json FROM messages'))[0]!.raw_json))
    expect(data).toMatchObject({
      content: 'edited live',
      author: { username: 'alice' },
      unknown_future_field: { value: 'preserved' }
    })
    expect(data.attachments).toHaveLength(1)
    get.mockResolvedValueOnce([message()]).mockResolvedValueOnce([])
    await call({ action: 'collect', restart: true })
    expect(await rows('SELECT content FROM messages')).toEqual([{ content: 'edited live' }])
  })

  it('hydrates uncached updates through the Discord API and still records unavailable-message events', async () => {
    await call({ action: 'watch' })
    get.mockResolvedValueOnce(message())
    service.handleGatewayPacket(
      packet('MESSAGE_UPDATE', {
        id: '1000000000000000100',
        content: 'changed',
        edited_timestamp: '2026-10-30T02:00:00Z'
      })
    )
    await service.flushRealtime()
    expect(get).toHaveBeenCalledWith(
      `/channels/${CHANNEL}/messages/1000000000000000100`,
      expect.objectContaining({ signal: expect.any(AbortSignal) })
    )
    expect(await rows('SELECT content, author_username FROM messages')).toEqual([
      { content: 'changed', author_username: 'alice' }
    ])
    get.mockRejectedValueOnce(Object.assign(new Error('missing'), { code: 10008 }))
    service.handleGatewayPacket(
      packet('MESSAGE_UPDATE', { id: '1000000000000000101', content: 'unavailable' }, 2)
    )
    expect(await service.flushRealtime()).toBe(1)
    expect(await rows('SELECT count(*)::INTEGER AS total FROM message_events')).toEqual([
      { total: 2 }
    ])
  })

  it('records deletions and bulk tombstones, retains previous content, and never resurrects deleted rows during backfill', async () => {
    await collectOne()
    service.handleGatewayPacket(packet('MESSAGE_DELETE', { id: '1000000000000000100' }))
    service.handleGatewayPacket(
      packet('MESSAGE_DELETE_BULK', { ids: ['1000000000000000099', '1000000000000000098'] }, 2)
    )
    await service.flushRealtime()
    expect(await rows('SELECT content, deleted_at IS NOT NULL AS deleted FROM messages')).toEqual([
      { content: 'Hello world', deleted: true }
    ])
    get.mockResolvedValueOnce([message('1000000000000000099')]).mockResolvedValueOnce([])
    await call({ action: 'collect', restart: true })
    expect(
      await rows('SELECT count(*)::INTEGER AS total FROM messages WHERE deleted_at IS NULL')
    ).toEqual([{ total: 0 }])
    expect(await rows('SELECT count(*)::INTEGER AS total FROM message_tombstones')).toEqual([
      { total: 3 }
    ])
  })

  it('retains raw reaction and poll events and supports stopping tracking without deleting the archive', async () => {
    await call({ action: 'watch' })
    service.handleGatewayPacket(
      packet('MESSAGE_REACTION_ADD', {
        message_id: '1000000000000000100',
        user_id: USER,
        emoji: { name: '👍' }
      })
    )
    service.handleGatewayPacket(
      packet(
        'MESSAGE_POLL_VOTE_ADD',
        { message_id: '1000000000000000100', user_id: USER, answer_id: 2 },
        2
      )
    )
    expect(await call({ action: 'unwatch' })).toMatchObject({ realtime_enabled: false })
    expect(service.handleGatewayPacket(packet('MESSAGE_CREATE', message()))).toBe(false)
    const events = await rows(
      'SELECT event_type, raw_json FROM message_events ORDER BY gateway_sequence'
    )
    expect(events.map((event) => event.event_type)).toEqual([
      'MESSAGE_REACTION_ADD',
      'MESSAGE_POLL_VOTE_ADD'
    ])
    expect(JSON.parse(String(events[0]!.raw_json))).toMatchObject({
      emoji: { name: '👍' },
      user_id: USER
    })
  })

  it('restores tracking and pending events after restart, with credentials redacted before durable persistence', async () => {
    await call({ action: 'watch' })
    service.handleGatewayPacket(packet('MESSAGE_CREATE', message()))
    await service.close()
    service = new DiscordArchiveService(
      { user: { id: BOT }, channels: { fetch: fetchChannel }, rest: { get } } as unknown as Client,
      directory,
      false
    )
    expect(await service.flushRealtime()).toBe(1)
    expect(await call({ action: 'status' })).toMatchObject({
      realtime_enabled: true,
      message_count: 1,
      queued_events: 0
    })
    expect(queueKeys()).toHaveLength(0)
  })

  it('discards corrupt persisted events with a visible channel gap warning', async () => {
    await call({ action: 'watch' })
    service.handleGatewayPacket(packet('MESSAGE_CREATE', message()))
    await service.close()
    const db = new DatabaseSync(join(directory, 'realtime-outbox.sqlite'))
    try {
      db.prepare('UPDATE events SET payload=?').run('{broken')
    } finally {
      db.close()
    }
    service = new DiscordArchiveService(
      { user: { id: BOT }, channels: { fetch: fetchChannel }, rest: { get } } as unknown as Client,
      directory,
      false
    )
    expect(await call({ action: 'status' })).toMatchObject({
      queued_events: 0,
      needs_history_refresh: true,
      realtime_issue: expect.stringContaining('Corrupt')
    })
  })

  it('flushes gateway events automatically without another /a command', async () => {
    await service.close()
    service = new DiscordArchiveService(
      { user: { id: BOT }, channels: { fetch: fetchChannel }, rest: { get } } as unknown as Client,
      directory
    )
    await call({ action: 'watch' })
    service.handleGatewayPacket(packet('MESSAGE_CREATE', message()))
    expect(queueKeys()).toHaveLength(1)
    await vi.waitFor(() => expect(queueKeys()).toHaveLength(0), { timeout: 4000 })
    expect(await rows('SELECT content FROM messages')).toEqual([{ content: 'Hello world' }])
  })

  it('ignores untracked channels, DMs, malformed payloads and disabled collection', async () => {
    await call({ action: 'watch' })
    expect(
      service.handleGatewayPacket(packet('MESSAGE_CREATE', { ...message(), channel_id: OTHER }))
    ).toBe(false)
    expect(
      service.handleGatewayPacket({ t: 'MESSAGE_CREATE', d: { ...message(), channel_id: OTHER } })
    ).toBe(false)
    expect(
      service.handleGatewayPacket(packet('MESSAGE_CREATE', { ...message(), id: 'invalid' }))
    ).toBe(false)
    expect(await call({ action: 'status' })).toMatchObject({
      needs_history_refresh: true,
      queued_events: 0
    })
    manageCommunitySettings({ action: 'update', settings: { discordArchive: { enabled: false } } })
    expect(service.handleGatewayPacket(packet('MESSAGE_CREATE', message()))).toBe(false)
    expect(await service.flushRealtime()).toBe(0)
    expect(await call({ action: 'unwatch' })).toMatchObject({ realtime_enabled: false })
  })

  it('pauses on permission failure, retains the durable event, and resumes after authorized re-enrollment', async () => {
    await call({ action: 'watch' })
    permissions.mockReturnValue({ has: () => false })
    service.handleGatewayPacket(packet('MESSAGE_CREATE', message()))
    expect(await service.flushRealtime()).toBe(0)
    expect(queueKeys()).toHaveLength(1)
    permissions.mockReturnValue({ has: () => true })
    await call({ action: 'watch' })
    expect(await service.flushRealtime()).toBe(1)
    expect(await call({ action: 'status' })).toMatchObject({
      message_count: 1,
      realtime_issue: null
    })
  })

  it('invalidates cached permissions on gateway changes and stops capture for removed administrators', async () => {
    await call({ action: 'watch' })
    service.handleGatewayPacket(packet('MESSAGE_CREATE', message()))
    await service.flushRealtime()
    permissions.mockReturnValue({ has: () => false })
    service.handleGatewayPacket({ t: 'CHANNEL_UPDATE', d: { id: CHANNEL, guild_id: GUILD } })
    service.handleGatewayPacket(
      packet('MESSAGE_UPDATE', { id: '1000000000000000100', content: 'unauthorized change' }, 2)
    )
    expect(await service.flushRealtime()).toBe(0)
    permissions.mockReturnValue({ has: () => true })
    const previous = process.env.ADMIN_USER_IDS
    process.env.ADMIN_USER_IDS = BOT
    try {
      expect(
        service.handleGatewayPacket(packet('MESSAGE_CREATE', message('1000000000000000101'), 3))
      ).toBe(false)
    } finally {
      process.env.ADMIN_USER_IDS = previous
    }
    await call({ action: 'unwatch' })
    expect(await call({ action: 'status' })).toMatchObject({
      needs_history_refresh: true,
      realtime_enabled: false
    })
  })

  it('pauses live writes at the storage quota without dropping pending data', async () => {
    manageCommunitySettings({
      action: 'update',
      settings: { discordArchive: { maxStorageMiB: 64 } }
    })
    await call({ action: 'watch' })
    const filler = join(directory, `${OTHER}.duckdb`)
    await writeFile(filler, '')
    await truncate(filler, 64 * 1024 * 1024)
    service.handleGatewayPacket(packet('MESSAGE_CREATE', message()))
    expect(await service.flushRealtime()).toBe(0)
    expect(await call({ action: 'status' })).toMatchObject({
      queued_events: 1,
      realtime_issue: expect.stringContaining('paused')
    })
    await rm(filler)
    await call({ action: 'watch' })
    expect(await service.flushRealtime()).toBe(1)
  })

  it('bounds the outbox and reports a gap instead of silently claiming complete capture', async () => {
    await call({ action: 'watch' })
    for (let sequence = 0; sequence < 1000; sequence++) {
      expect(
        service.handleGatewayPacket(
          packet(
            'MESSAGE_REACTION_ADD',
            { message_id: '1000000000000000100', user_id: USER, emoji: { name: '👍' } },
            sequence
          )
        )
      ).toBe(true)
    }
    expect(
      service.handleGatewayPacket(
        packet(
          'MESSAGE_REACTION_ADD',
          { message_id: '1000000000000000100', user_id: USER, emoji: { name: '👍' } },
          1001
        )
      )
    ).toBe(false)
    expect(queueKeys()).toHaveLength(1000)
    expect(await call({ action: 'status' })).toMatchObject({ needs_history_refresh: true })
    await call({ action: 'delete' })
    expect(queueKeys()).toHaveLength(0)
    expect(service.handleGatewayPacket(packet('MESSAGE_CREATE', message()))).toBe(false)
  })

  it('expires old pending events and makes the gap visible', async () => {
    await call({ action: 'watch' })
    service.handleGatewayPacket(packet('MESSAGE_CREATE', message()))
    const now = Date.now()
    vi.spyOn(Date, 'now').mockReturnValue(now + 8 * 24 * 60 * 60_000)
    expect(await service.flushRealtime()).toBe(0)
    expect(await call({ action: 'status' })).toMatchObject({
      needs_history_refresh: true,
      queued_events: 0,
      message_count: 0
    })
  })

  it('buffers during backfill and applies live changes without racing the history writer', async () => {
    await call({ action: 'watch' })
    let release!: (value: unknown) => void
    get
      .mockReturnValueOnce(
        new Promise((resolve) => {
          release = resolve
        })
      )
      .mockResolvedValueOnce([])
    const collecting = call({ action: 'collect' })
    await vi.waitFor(() => expect(get).toHaveBeenCalled())
    service.handleGatewayPacket(
      packet('MESSAGE_CREATE', message('1000000000000000100', { content: 'live version' }))
    )
    expect(await service.flushRealtime()).toBe(0)
    release([message()])
    expect(await collecting).toMatchObject({ complete: true })
    expect(await rows('SELECT content FROM messages')).toEqual([{ content: 'live version' }])
  })

  it('routes the production raw gateway listener and detaches cleanly on shutdown', async () => {
    await call({ action: 'watch' })
    const emitter = Object.assign(new EventEmitter(), { isReady: () => false })
    setDiscordArchiveClient(emitter as unknown as Client, service)
    emitter.emit(Events.ClientReady)
    emitter.emit(Events.Raw, packet('MESSAGE_CREATE', message()))
    expect(await service.flushRealtime()).toBe(1)
    expect(await rows('SELECT count(*)::INTEGER AS total FROM messages')).toEqual([{ total: 1 }])
    await closeDiscordArchive()
    expect(emitter.listenerCount(Events.Raw)).toBe(0)
  })
})

describe('member-accessible role search', () => {
  const input = {
    guildId: GUILD,
    channelId: CHANNEL,
    userId: OTHER,
    requestMessageId: '1000000000000000200',
    keyword: '바나나',
    scope: 'all' as const
  }
  function enable() {
    manageCommunitySettings({
      action: 'update',
      settings: { discordArchive: { searchRoleId: SEARCH_ROLE } }
    })
  }
  it('searches pre-realtime snapshots without requiring an administrator to migrate them', async () => {
    enable()
    await collectOne()
    await call({ action: 'unwatch' })
    const instance = await DuckDBInstance.create(join(directory, `${CHANNEL}.duckdb`))
    const connection = await instance.connect()
    try {
      await connection.run('ALTER TABLE messages DROP COLUMN deleted_at')
      await connection.run('ALTER TABLE messages DROP COLUMN last_gateway_at')
      await connection.run('DROP TABLE message_events')
      await connection.run('DROP TABLE message_tombstones')
    } finally {
      connection.closeSync()
      instance.closeSync()
    }
    get.mockResolvedValueOnce(message())
    const result = await service.search({ ...input, keyword: 'Hello', scope: 'content' })
    expect(result.matches).toHaveLength(1)
    expect(result.matches[0]!.id).toBe('1000000000000000100')
    expect(await call({ action: 'status' })).toMatchObject({
      message_count: 1,
      realtime_enabled: false
    })
    get.mockRejectedValueOnce(Object.assign(new Error('offline deleted'), { code: 10008 }))
    expect(
      (await service.search({ ...input, keyword: 'Hello', scope: 'content' })).matches
    ).toEqual([])
  })
  async function seed(records: ReturnType<typeof message>[]) {
    get.mockResolvedValueOnce(records).mockResolvedValueOnce([])
    await call({ action: 'collect' })
    get.mockImplementation(async (route: string) => {
      const found = records.find((item) => route.endsWith('/' + item.id))
      if (!found) throw new Error('Unexpected message lookup')
      return found
    })
  }

  it('lets ordinary members search literal content or embed string values without granting SQL access', async () => {
    enable()
    await seed([
      message('1000000000000000100', { content: '바나나 BANANA' }),
      message('1000000000000000099', {
        content: '',
        embeds: [{ title: '과일', fields: [{ name: '종류', value: '바나나' }] }]
      }),
      message('1000000000000000098', {
        content: 'other',
        embeds: [{ 바나나: 'only a JSON key, not matching text' }]
      })
    ])
    expect((await service.search(input)).matches.map((item) => item.id)).toEqual([
      '1000000000000000100',
      '1000000000000000099'
    ])
    expect(
      (await service.search({ ...input, scope: 'content' })).matches.map((item) => item.field)
    ).toEqual(['content'])
    expect(
      (await service.search({ ...input, scope: 'embeds' })).matches.map((item) => item.field)
    ).toEqual(['embeds'])
    expect((await service.search({ ...input, keyword: 'banana' })).matches).toHaveLength(1)
    await expect(
      service.run({ action: 'query', channelId: CHANNEL, sql: 'SELECT * FROM messages' }, OTHER)
    ).rejects.toThrow('administrator')
    expect(fetchMember).toHaveBeenCalledWith(OTHER)
  })

  it('treats SQL operators and wildcard characters as literal search text', async () => {
    enable()
    await seed([
      message('1000000000000000100', { content: '100%_literal' }),
      message('1000000000000000099', { content: 'ordinary' })
    ])
    expect((await service.search({ ...input, keyword: '%_' })).matches).toHaveLength(1)
    expect((await service.search({ ...input, keyword: "' OR true --" })).matches).toHaveLength(0)
    expect(await rows('SELECT count(*)::INTEGER AS total FROM messages')).toEqual([{ total: 2 }])
  })

  it('excludes observed deletes, role-search requests and search replies, and rechecks current Discord content before disclosure', async () => {
    enable()
    await seed([
      message('1000000000000000100', { content: '바나나' }),
      message('1000000000000000099', { content: '바나나' }),
      message('1000000000000000098', { content: `<&@${SEARCH_ROLE}> "바나나" 찾아줘` }),
      message('1000000000000000097', {
        content: '**아카이브 검색** 바나나',
        author: { id: BOT, username: 'bot', bot: true }
      }),
      message('1000000000000000096', { content: '바나나' })
    ])
    service.handleGatewayPacket(packet('MESSAGE_DELETE', { id: '1000000000000000096' }))
    await service.flushRealtime()
    get.mockImplementation(async (route: string) => {
      if (route.endsWith('/1000000000000000100'))
        throw Object.assign(new Error('offline deleted'), { code: 10008 })
      if (route.endsWith('/1000000000000000099'))
        return message('1000000000000000099', {
          content: 'edited to remove the search word',
          embeds: []
        })
      throw new Error('Search should not fetch excluded messages')
    })
    expect((await service.search(input)).matches).toEqual([])
  })

  it('requires current requester/bot channel permissions and matching guild identity', async () => {
    enable()
    await seed([message('1000000000000000100', { content: '바나나' })])
    await expect(service.search({ ...input, guildId: OTHER })).rejects.toThrow('guild mismatch')
    permissions.mockReturnValue({ has: () => false })
    await expect(service.search(input)).rejects.toThrow('View Channel')
  })

  it('returns at most five verified results and reports additional matches', async () => {
    enable()
    await seed(
      Array.from({ length: 8 }, (_, index) =>
        message(String(1000000000000000100n + BigInt(index)), { content: '바나나' })
      )
    )
    const result = await service.search(input)
    expect(result.matches).toHaveLength(5)
    expect(result.more).toBe(true)
    expect(result.historyComplete).toBe(true)
  })

  it('fails closed on failed or malformed live message verification', async () => {
    enable()
    await seed([message('1000000000000000100', { content: '바나나' })])
    get.mockRejectedValueOnce(new Error('network timeout'))
    await expect(service.search(input)).rejects.toThrow('Could not verify')
    get.mockResolvedValueOnce({ id: '1000000000000000100', channel_id: OTHER })
    await expect(service.search(input)).rejects.toThrow('Invalid search message')
  })

  it('requires an existing archive and an enabled search-role configuration', async () => {
    await expect(service.search(input)).rejects.toThrow('disabled')
    enable()
    await expect(service.search(input)).rejects.toThrow('collect this channel first')
  })
})
