import { join } from 'node:path'
import {
  ChannelType,
  MessageFlags,
  type Message,
  type MessageReaction,
  type User
} from 'discord.js'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  recordMessageOriginal,
  recordMessageEdit,
  showMessageEditHistory,
  deleteMessageEditHistory,
  deleteMessagesEditHistory
} from '../message-edit-history.js'
import { manageCommunitySettings } from '../community-settings.js'
import {
  clearStoredValues,
  getStoredValue,
  setStoredValue,
  isInternalStoredKey
} from '../helpers/kv-store.js'
import { isolateStoredValues } from '../helpers/kv-store-test.js'

const GUILD = '333333333333333333'
const CHANNEL = '777777777777777777'
const ID = '1000000000000000001'
const KEY = `community:message-edit-history:${GUILD}`
const react = vi.fn()
const send = vi.fn()
const dm = vi.fn()
const hasPermission = vi.fn()
const fetchMember = vi.fn()
const threadMember = vi.fn()
let userCounter = 0
function message(content = '수정 전', extra: object = {}) {
  const result = {
    id: ID,
    guildId: GUILD,
    channelId: CHANNEL,
    content,
    partial: false,
    author: { id: '555555555555555555', bot: false },
    createdTimestamp: Date.now() - 1000,
    editedTimestamp: null,
    url: `https://discord.com/channels/${GUILD}/${CHANNEL}/${ID}`,
    guild: { members: { fetch: fetchMember } },
    channel: {
      isDMBased: () => false,
      permissionsFor: () => ({ has: hasPermission }),
      type: ChannelType.GuildText,
      members: { fetch: threadMember }
    },
    react,
    reply: send,
    ...extra
  } as unknown as Message
  result.fetch = vi.fn().mockResolvedValue(result)
  return result
}
function user() {
  return { id: String(++userCounter), bot: false, send: dm } as unknown as User
}
function reaction(source: Message, emoji = '✏️') {
  return { message: source, emoji: { name: emoji } } as MessageReaction
}
async function edited() {
  const before = message()
  recordMessageOriginal(before)
  const after = message('수정 후', { editedTimestamp: Date.now() })
  await recordMessageEdit(before, after)
  return after
}
function state() {
  return JSON.parse(getStoredValue(KEY)!)[ID]
}

beforeEach(() => {
  vi.useFakeTimers()
  isolateStoredValues(join(process.cwd(), '.tmp', 'message-edit-history.test.sqlite'))
  clearStoredValues()
  react.mockReset().mockResolvedValue(undefined)
  send.mockReset().mockResolvedValue(undefined)
  dm.mockReset()
  hasPermission.mockReset().mockReturnValue(true)
  fetchMember.mockReset().mockResolvedValue({ permissions: { has: () => false } })
  threadMember.mockReset().mockResolvedValue({})
})
afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('message edit history', () => {
  it('persists original and edited text and adds a pencil reaction', async () => {
    await edited()
    expect(state().versions.map((v: { content: string }) => v.content)).toEqual([
      '수정 전',
      '수정 후'
    ])
    expect(react).toHaveBeenCalledWith('✏️')
    expect(isInternalStoredKey(KEY)).toBe(true)
  })
  it('replies to the original message in the channel, never via DM', async () => {
    const source = await edited()
    const viewer = user()
    await showMessageEditHistory(reaction(source), viewer)
    expect(fetchMember).toHaveBeenCalledWith({ user: viewer.id, force: true })
    expect(source.fetch).toHaveBeenCalledWith(true)
    const payload = send.mock.calls[0]![0]
    expect(payload.flags).toBe(MessageFlags.IsComponentsV2)
    expect(payload.allowedMentions).toEqual({ parse: [], repliedUser: false })
    expect(payload.components).toHaveLength(1)
    expect(payload.components[0].toJSON().content).toBe('~~전~~')
    expect(payload).not.toHaveProperty('files')
    expect(payload).not.toHaveProperty('embeds')
    expect(dm).not.toHaveBeenCalled()
  })
  it('ignores duplicate updates and metadata-only changes', async () => {
    const source = await edited()
    await recordMessageEdit(source, source)
    expect(react).toHaveBeenCalledTimes(1)
    expect(state().versions).toHaveLength(2)
    await recordMessageEdit(message('a'), message('b'))
    expect(react).toHaveBeenCalledTimes(1)
  })
  it('replies with only deleted fragments on one line across multiple edits', async () => {
    const before = message('abcde')
    recordMessageOriginal(before)
    const first = message('aXcdY', { editedTimestamp: Date.now() })
    await recordMessageEdit(before, first)
    const second = message('aXcY!', { editedTimestamp: Date.now() + 1 })
    await recordMessageEdit(first, second)
    await showMessageEditHistory(reaction(second), user())
    expect(send.mock.calls[0]![0].components[0].toJSON().content).toBe('~~b~~ ~~e~~ ~~d~~')
  })
  it('does not send an empty reply for legacy insertion-only history', async () => {
    const source = await edited()
    const entry = state()
    entry.versions = [
      { content: 'a', at: Date.now() - 1 },
      { content: 'ab', at: Date.now() }
    ]
    setStoredValue(KEY, JSON.stringify({ [ID]: entry }))
    await showMessageEditHistory(reaction(source), user())
    expect(send).not.toHaveBeenCalled()
    expect(source.fetch).not.toHaveBeenCalled()
  })
  it('uses stored originals when old messages are partial and fetches partial updates', async () => {
    recordMessageOriginal(message())
    const after = message('새 내용', { editedTimestamp: Date.now() })
    const partial = message('', { partial: true, content: null })
    partial.fetch = vi.fn().mockResolvedValue(after)
    await recordMessageEdit(partial, partial)
    expect(state().versions[0].content).toBe('수정 전')
    expect(state().versions[1].content).toBe('새 내용')
  })
  it('does not fabricate an unknown original', async () => {
    await recordMessageEdit(
      message('', { partial: true, content: null }),
      message('현재', { editedTimestamp: Date.now() })
    )
    expect(state().versions.map((v: { content: string }) => v.content)).toEqual(['현재'])
    expect(react).not.toHaveBeenCalled()
  })
  it('records insertion-only edits without adding a pencil or showing empty deletion history', async () => {
    const before = message('ac')
    recordMessageOriginal(before)
    const after = message('abcd', { editedTimestamp: Date.now() })
    await recordMessageEdit(before, after)
    expect(state().versions.map((v: { content: string }) => v.content)).toEqual(['ac', 'abcd'])
    expect(state().edited).toBe(false)
    expect(react).not.toHaveBeenCalled()
    await showMessageEditHistory(reaction(after), user())
    expect(send).not.toHaveBeenCalled()
    const removed = message('acd', { editedTimestamp: Date.now() + 1 })
    await recordMessageEdit(after, removed)
    expect(react).toHaveBeenCalledWith('✏️')
    expect(state().edited).toBe(true)
  })
  it('does not add another pencil for insertions after a deletion', async () => {
    const before = await edited()
    await recordMessageEdit(before, message('수정 후 추가', { editedTimestamp: Date.now() + 1 }))
    expect(react).toHaveBeenCalledTimes(1)
    expect(state().edited).toBe(true)
  })
  it('ignores bots, DMs, other emoji and disabled configuration', async () => {
    const source = await edited()
    await showMessageEditHistory(reaction(source, '⭐'), user())
    await showMessageEditHistory(reaction(source), { ...user(), bot: true } as User)
    recordMessageOriginal(message('dm', { guildId: null }))
    manageCommunitySettings({
      action: 'update',
      settings: { messageEditHistory: { enabled: false } }
    })
    await recordMessageEdit(source, message('변경', { editedTimestamp: Date.now() }))
    await showMessageEditHistory(reaction(source), user())
    expect(send).not.toHaveBeenCalled()
    expect(react).toHaveBeenCalledTimes(1)
  })
  it('denies users without channel access or private-thread membership', async () => {
    const source = await edited()
    hasPermission.mockReturnValue(false)
    await showMessageEditHistory(reaction(source), user())
    hasPermission.mockReturnValue(true)
    source.channel.type = ChannelType.PrivateThread
    threadMember.mockRejectedValue(new Error('not a member'))
    await showMessageEditHistory(reaction(source), user())
    expect(send).not.toHaveBeenCalled()
  })
  it('isolates history by guild, channel and author', async () => {
    await edited()
    for (const extra of [
      { guildId: '999999999999999999' },
      { channelId: '888888888888888888' },
      { author: { id: '999999999999999999', bot: false } }
    ]) {
      await showMessageEditHistory(reaction(message('수정 후', extra)), user())
    }
    expect(send).not.toHaveBeenCalled()
  })
  it('rate limits duplicate clicks', async () => {
    const source = await edited()
    const viewer = user()
    await showMessageEditHistory(reaction(source), viewer)
    await showMessageEditHistory(reaction(source), viewer)
    expect(send).toHaveBeenCalledTimes(1)
  })
  it('handles corrupt, expired and deleted state without disclosing history', async () => {
    const source = await edited()
    setStoredValue(KEY, '{broken')
    await showMessageEditHistory(reaction(source), user())
    await edited()
    vi.advanceTimersByTime(31 * 24 * 60 * 60_000)
    await showMessageEditHistory(reaction(source), user())
    await edited()
    deleteMessageEditHistory(source)
    await showMessageEditHistory(reaction(source), user())
    expect(send).not.toHaveBeenCalled()
  })
  it('caps versions, stored text and reply length even for Markdown-heavy input', async () => {
    let source = await edited()
    for (let i = 0; i < 20; i++) {
      const next = message('*'.repeat(5000) + i, { editedTimestamp: Date.now() + i })
      // Ensure the stored prefix changes too.
      next.content = `${i}${next.content}`
      await recordMessageEdit(source, next)
      source = next
    }
    expect(state().versions).toHaveLength(10)
    expect(state().versions.every((v: { content: string }) => v.content.length <= 4000)).toBe(true)
    await showMessageEditHistory(reaction(source), user())
    expect(send.mock.calls[0]![0].components[0].toJSON().content.length).toBeLessThan(4000)
  })
  it('caps messages per guild and supports clearing through /a settings', () => {
    recordMessageOriginal(message())
    const entry = state()
    setStoredValue(
      KEY,
      JSON.stringify(Object.fromEntries(Array.from({ length: 200 }, (_, i) => [String(i), entry])))
    )
    vi.advanceTimersByTime(1)
    recordMessageOriginal(message('new'))
    expect(Object.keys(JSON.parse(getStoredValue(KEY)!))).toHaveLength(200)
    expect(state().versions[0].content).toBe('new')
    manageCommunitySettings({ action: 'reset-message-edit-history' })
    expect(getStoredValue(KEY)).toBeUndefined()
  })
  it('propagates channel reply failures without falling back to DM', async () => {
    const source = await edited()
    send.mockRejectedValue(new Error('Cannot reply'))
    await expect(showMessageEditHistory(reaction(source), user())).rejects.toThrow('Cannot reply')
    expect(dm).not.toHaveBeenCalled()
  })
  it('clears bulk-deleted messages without clearing other messages', async () => {
    const source = await edited()
    recordMessageOriginal(message('kept', { id: 'other' }))
    deleteMessagesEditHistory([source])
    const records = JSON.parse(getStoredValue(KEY)!)
    expect(records[ID]).toBeUndefined()
    expect(records.other.versions[0].content).toBe('kept')
  })
  it('times out stalled network operations', async () => {
    react.mockReturnValue(new Promise(() => {}))
    const pending = expect(edited()).rejects.toThrow('timed out')
    await vi.advanceTimersByTimeAsync(10_000)
    await pending
  })
})
