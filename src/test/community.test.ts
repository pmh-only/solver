import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { join } from 'node:path'
import { createCanvas, loadImage } from '@napi-rs/canvas'
import { MessageFlags, PermissionsBitField, type Client, type Guild } from 'discord.js'
import { leisureCommands } from '../commands/community-leisure.js'
import { defaultFoods } from '../commands/community-foods.js'
import {
  COMMUNITY_CONFIRM_ID,
  guildCommunityCommands,
  parseRoleColor
} from '../commands/community-guild.js'
import { KICKVOTE_BUTTON_ID, subcommand as kickvote } from '../commands/kickvote.js'
import { createHelpSubcommand } from '../commands/help.js'
import { fetchCommunityBytes } from '../commands/community-http.js'
import { normalizeEmojiImage } from '../commands/community-image.js'
import {
  loadCommunityState,
  pruneCommunityState,
  saveCommunityState
} from '../commands/community-state.js'
import {
  communitySettingsSchema,
  loadCommunitySettings,
  manageCommunitySettings
} from '../community-settings.js'
import {
  clearStoredValues,
  getStoredValue,
  isInternalStoredKey,
  listStoredKeys,
  setStoredValue
} from '../helpers/kv-store.js'
import { isolateStoredValues } from '../helpers/kv-store-test.js'
import { subcommand as list } from '../commands/list.js'
import {
  autocompleteJSON,
  buttonJSON,
  commandJSON,
  dispatch,
  getCallback,
  getEdit,
  makeSubcommands,
  type RawInteraction
} from './e2e.js'

const USER = '666666666666666666'
const OTHER = '555555555555555555'
const TARGET = '444444444444444444'
const GUILD = '333333333333333333'
const CHANNEL = '777777777777777777'
const ROLE = '222222222222222222'
const commands = [...leisureCommands, ...guildCommunityCommands, kickvote]
const subs = makeSubcommands(...commands, createHelpSubcommand(commands), list)
const fetchMock = vi.fn<typeof fetch>()
const kick = vi.fn().mockResolvedValue(undefined)
const addRole = vi.fn().mockResolvedValue(undefined)
const editRole = vi.fn()
const createRole = vi.fn()
const createInvite = vi.fn()
const createEmoji = vi.fn()
const webhookSend = vi.fn()
const webhookDelete = vi.fn()
const createWebhook = vi.fn()
let targetProtected = false
let voterBot = false
let unsafeStoredRole = false

function guildData(userId = USER, permissions = '8'): RawInteraction {
  return {
    guild_id: GUILD,
    channel: { id: CHANNEL },
    user: { id: userId, username: 'member', discriminator: '0', avatar: null },
    member: {
      user: { id: userId, username: 'member', discriminator: '0', avatar: null },
      roles: [],
      permissions,
      joined_at: '2020-01-01T00:00:00Z'
    }
  }
}

function configureClient(client: Client) {
  const guild = (client.guilds as unknown as { _add(data: unknown): Guild })._add({
    id: GUILD,
    name: 'test',
    owner_id: OTHER
  })
  const role = {
    id: ROLE,
    name: `color-${USER}`,
    editable: true,
    managed: false,
    permissions: new PermissionsBitField(unsafeStoredRole ? ['Administrator'] : []),
    edit: editRole
  }
  editRole.mockResolvedValue(role)
  createRole.mockResolvedValue(role)
  const member = (id: string) => ({
    id,
    user: { id, bot: id === TARGET ? false : voterBot },
    joinedTimestamp: new Date('2020-01-01T00:00:00Z').getTime(),
    permissions: new PermissionsBitField(
      id === TARGET && !targetProtected ? [] : ['Administrator']
    ),
    kickable: !targetProtected,
    kick,
    roles: { add: addRole }
  })
  vi.spyOn(guild.members, 'fetch').mockImplementation((async (id: string) => member(id)) as never)
  vi.spyOn(guild.members, 'fetchMe').mockResolvedValue(member(USER) as never)
  vi.spyOn(guild.roles, 'create').mockImplementation(createRole)
  vi.spyOn(guild.roles, 'fetch').mockResolvedValue(role as never)
  vi.spyOn(guild.invites, 'create').mockImplementation(createInvite)
  vi.spyOn(guild.emojis, 'create').mockImplementation(createEmoji)
  vi.spyOn(guild.channels, 'fetch').mockResolvedValue({ createWebhook } as never)
}
const options = { configureClient }
const guildCommand = (input: string, permissions = '8') =>
  dispatch(commandJSON(input, guildData(USER, permissions)), subs, options)
function callbackData(calls: Awaited<ReturnType<typeof dispatch>>) {
  return (getCallback(calls) as { type: number; data: { flags: number; components: unknown[] } })
    .data
}
async function confirmation(input: string) {
  const data = callbackData(await guildCommand(input))
  return { components: data.components, flags: data.flags }
}
async function clickConfirm(
  source: Awaited<ReturnType<typeof confirmation>>,
  user = USER,
  customId = COMMUNITY_CONFIRM_ID,
  permissions = '8'
) {
  return dispatch(
    buttonJSON(source.components, customId, guildData(user, permissions), source.flags),
    subs,
    options
  )
}
async function startVote() {
  manageCommunitySettings({ action: 'update', guildId: GUILD, settings: { kickvoteThreshold: 2 } })
  const calls = await guildCommand(`kickvote <@${TARGET}> 스팸 --pub`)
  const edit = getEdit(calls) as { components: unknown[] }
  expect(JSON.stringify(edit)).toContain('0/2')
  return edit.components
}
async function vote(components: unknown[], user = USER, permissions = '0') {
  return dispatch(
    buttonJSON(components, KICKVOTE_BUTTON_ID, guildData(user, permissions)),
    subs,
    options
  )
}

beforeEach(() => {
  vi.useFakeTimers()
  isolateStoredValues(join(process.cwd(), '.tmp', 'community.test.sqlite'))
  clearStoredValues()
  vi.clearAllMocks()
  targetProtected = false
  voterBot = false
  unsafeStoredRole = false
  fetchMock.mockReset().mockRejectedValue(new Error('unmocked network request'))
  vi.stubGlobal('fetch', fetchMock)
  createInvite.mockResolvedValue({ url: 'https://discord.gg/test' })
  createEmoji.mockResolvedValue({ id: ROLE })
  webhookSend.mockResolvedValue(undefined)
  webhookDelete.mockResolvedValue(undefined)
  createWebhook.mockResolvedValue({ send: webhookSend, delete: webhookDelete })
})
afterEach(() => {
  vi.clearAllTimers()
  vi.useRealTimers()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('imported leisure commands', () => {
  it.each(['food', 'foods', '점메추', '저메추'])(
    '%s uses the imported menu and is private by default',
    async (name) => {
      const calls = await dispatch(commandJSON(name), subs)
      expect(callbackData(calls).flags & MessageFlags.Ephemeral).toBeTruthy()
      const json = JSON.stringify(getEdit(calls))
      expect(defaultFoods.some((food) => json.includes(food.name))).toBe(true)
      expect(json).toContain('retry:')
      expect(json).toContain('edit-parameters')
    }
  )
  it('filters foods by tags and supports short public flags', async () => {
    const calls = await dispatch(commandJSON('food 멕시칸 치즈 -p'), subs)
    expect(callbackData(calls).flags ?? 0).toBe(0)
    expect(JSON.stringify(getEdit(calls))).toContain('퀘사디아')
  })
  it('reports no matching food', async () => {
    const calls = await dispatch(commandJSON('food nonexistent'), subs)
    expect(JSON.stringify(getEdit(calls))).toContain('조건에 맞는 음식이 없습니다')
  })
  it('uses the configured menu immediately', async () => {
    manageCommunitySettings({
      action: 'update',
      guildId: USER,
      settings: { foods: [{ name: '테스트 메뉴', tags: ['테스트'] }] }
    })
    const calls = await dispatch(commandJSON('food'), subs)
    expect(JSON.stringify(getEdit(calls))).toContain('테스트 메뉴')
  })
  it('fetches and validates the unofficial pizza index with a deferred reply', async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ defcon_level: 3 })))
    const calls = await dispatch(commandJSON('pizza --pub'), subs)
    expect((getCallback(calls) as { type: number }).type).toBe(5)
    expect(JSON.stringify(getEdit(calls))).toContain('DEFCON 3')
    expect(JSON.stringify(getEdit(calls))).toContain('비공식')
    expect(fetchMock).toHaveBeenCalledWith(
      expect.any(URL),
      expect.objectContaining({ redirect: 'error', signal: expect.any(AbortSignal) })
    )
  })
  it.each(['{"defcon_level":0}', '{"defcon_level":6}', 'not json'])(
    'rejects malformed pizza data %s',
    async (body) => {
      fetchMock.mockResolvedValue(new Response(body))
      const calls = await dispatch(commandJSON('pizza'), subs)
      expect(JSON.stringify(getEdit(calls))).not.toContain('PIZZA INDEX')
    }
  )
  it('handles network failure and validates arguments before fetching', async () => {
    const failed = await dispatch(commandJSON('pizza'), subs)
    expect(JSON.stringify(getEdit(failed))).toContain('unmocked network request')
    fetchMock.mockClear()
    expect(JSON.stringify(getCallback(await dispatch(commandJSON('pizza bad'), subs)))).toContain(
      '인수가 필요하지 않습니다'
    )
    expect(fetchMock).not.toHaveBeenCalled()
  })
  it('renders now immediately and exposes help/autocomplete', async () => {
    const data = callbackData(await dispatch(commandJSON('now'), subs))
    expect(data.flags & MessageFlags.IsComponentsV2).toBeTruthy()
    expect(JSON.stringify(data)).toContain(String(Date.now()))
    expect(JSON.stringify(getCallback(await dispatch(commandJSON('help'), subs)))).toContain(
      'kickvote'
    )
    expect(JSON.stringify(getCallback(await dispatch(commandJSON('help color'), subs)))).toContain(
      '#rrggbb'
    )
    expect(
      JSON.stringify(getCallback(await dispatch(autocompleteJSON('help ki'), subs)))
    ).toContain('kickvote')
    expect(JSON.stringify(getCallback(await dispatch(autocompleteJSON('piz'), subs)))).toContain(
      'pizza'
    )
  })
})

describe('community settings and resource limits', () => {
  it('defaults, scopes, updates, and resets settings', () => {
    expect(loadCommunitySettings(GUILD).kickvoteThreshold).toBe(7)
    manageCommunitySettings({
      action: 'update',
      guildId: GUILD,
      settings: { kickvoteThreshold: 3 }
    })
    expect(loadCommunitySettings(GUILD).kickvoteThreshold).toBe(3)
    manageCommunitySettings({
      action: 'update',
      guildId: GUILD,
      settings: { anonymousName: '익명' }
    })
    expect(loadCommunitySettings(GUILD)).toMatchObject({
      kickvoteThreshold: 3,
      anonymousName: '익명'
    })
    expect(loadCommunitySettings(OTHER).kickvoteThreshold).toBe(7)
    expect(manageCommunitySettings({ action: 'reset', guildId: GUILD }).kickvoteThreshold).toBe(7)
  })
  it.each([
    { kickvoteThreshold: 1 },
    { inviteMaxAgeHours: 999 },
    { foods: [] },
    { kickvoteChannelId: 'bad' },
    { disabledCommands: ['unknown'] }
  ])('rejects unsafe configuration %j', (settings) => {
    expect(() => manageCommunitySettings({ action: 'update', guildId: GUILD, settings })).toThrow()
  })
  it('fails closed on corrupt configuration, and reset recovers it', async () => {
    setStoredValue(`community:settings:${USER}`, 'not json')
    const calls = await dispatch(commandJSON('food'), subs)
    expect(JSON.stringify(getCallback(calls))).not.toContain('오늘의 메뉴')
    expect(manageCommunitySettings({ action: 'reset', guildId: USER }).disabledCommands).toEqual([])
  })
  it('disables commands including food aliases', async () => {
    manageCommunitySettings({
      action: 'update',
      guildId: USER,
      settings: { disabledCommands: ['food'] }
    })
    expect(JSON.stringify(getCallback(await dispatch(commandJSON('점메추'), subs)))).toContain(
      '비활성화'
    )
  })
  it('hides all community state from list and shorthand lookup', async () => {
    setStoredValue('community:settings:secret', 'private')
    setStoredValue('community:transient:vote:secret', 'private')
    setStoredValue('community:role:secret', 'private')
    expect(isInternalStoredKey('community:settings:secret')).toBe(true)
    const calls = await dispatch(commandJSON('list community'), subs)
    expect(JSON.stringify(getCallback(calls))).not.toContain('secret')
    expect(
      JSON.stringify(getCallback(await dispatch(commandJSON('community:settings:secret'), subs)))
    ).not.toContain('private')
  })
  it('expires corrupt state and bounds transient growth', () => {
    setStoredValue('community:transient:bad', 'not json')
    expect(loadCommunityState('bad', communitySettingsSchema)).toBeNull()
    for (let i = 0; i < 200; i++) saveCommunityState(`test:${i}`, { expiresAt: Date.now() + 1000 })
    expect(() => pruneCommunityState()).toThrow('진행 중인 요청')
    vi.advanceTimersByTime(1001)
    pruneCommunityState()
    expect(listStoredKeys().filter((key) => key.startsWith('community:transient:'))).toEqual([])
  }, 20_000)
  it.each([
    'http://cdn.discordapp.com/a',
    'https://127.0.0.1/a',
    'https://cdn.discordapp.com.evil.test/a',
    'https://user:pass@cdn.discordapp.com/a',
    'https://cdn.discordapp.com:444/a'
  ])('blocks an untrusted image URL %s before fetch', async (url) => {
    await expect(fetchCommunityBytes(url, 100)).rejects.toThrow()
    expect(fetchMock).not.toHaveBeenCalled()
  })
  it('caps response bytes even without a Content-Length header', async () => {
    fetchMock.mockResolvedValue(new Response('too many bytes'))
    await expect(fetchCommunityBytes('https://cdn.discordapp.com/a', 4)).rejects.toThrow('크기')
  })
  it('bounds concurrent downloads and releases slots after completion', async () => {
    const releases: Array<(response: Response) => void> = []
    fetchMock.mockImplementation(() => new Promise((resolve) => releases.push(resolve)))
    const pending = Array.from({ length: 4 }, () =>
      fetchCommunityBytes('https://cdn.discordapp.com/a', 100)
    )
    await expect(fetchCommunityBytes('https://cdn.discordapp.com/a', 100)).rejects.toThrow(
      '요청이 너무 많습니다'
    )
    releases.forEach((resolve) => resolve(new Response('ok')))
    await Promise.all(pending)
    fetchMock.mockResolvedValue(new Response('ok'))
    await expect(fetchCommunityBytes('https://cdn.discordapp.com/a', 100)).resolves.toEqual(
      Buffer.from('ok')
    )
  })
  it('handles failed HTTP status and rejected redirects/timeouts', async () => {
    fetchMock.mockResolvedValueOnce(new Response('error', { status: 500 }))
    await expect(fetchCommunityBytes('https://cdn.discordapp.com/a', 100)).rejects.toThrow('500')
    fetchMock.mockRejectedValueOnce(new DOMException('timeout', 'TimeoutError'))
    await expect(fetchCommunityBytes('https://cdn.discordapp.com/a', 100)).rejects.toThrow(
      'timeout'
    )
  })
  it('resizes images to 128px and rejects unsupported/oversized image headers before decoding', async () => {
    const input = await createCanvas(256, 128).encode('png')
    const result = await loadImage(await normalizeEmojiImage(input))
    expect([result.width, result.height]).toEqual([128, 64])
    await expect(normalizeEmojiImage(Buffer.from('<svg/>'))).rejects.toThrow('PNG')
    const huge = Buffer.from(input)
    huge.writeUInt32BE(100_000, 16)
    await expect(normalizeEmojiImage(huge)).rejects.toThrow('이미지 크기')
  })
  it('bounds concurrent image decodes', async () => {
    const data = await createCanvas(16, 16).encode('png')
    const pending = [normalizeEmojiImage(data), normalizeEmojiImage(data)]
    await expect(normalizeEmojiImage(data)).rejects.toThrow('이미지 처리 요청이 너무 많습니다')
    await Promise.all(pending)
    await expect(normalizeEmojiImage(data)).resolves.toBeInstanceOf(Buffer)
  })
})

describe('guild commands and confirmations', () => {
  it.each([
    'date',
    'color #fff',
    'invite',
    'anon hello',
    'emoji smile https://cdn.discordapp.com/a',
    `kickvote ${TARGET} spam --pub`
  ])('rejects %s in DMs', async (input) => {
    expect(JSON.stringify(getCallback(await dispatch(commandJSON(input), subs)))).toContain(
      '서버에서만'
    )
  })
  it('queries the default/selected member join date', async () => {
    expect(JSON.stringify(getEdit(await guildCommand('date')))).toContain('<t:1577836800:F>')
    expect(JSON.stringify(getEdit(await guildCommand(`date <@${TARGET}> --pub`)))).toContain(
      `<@${TARGET}>`
    )
    expect(JSON.stringify(getCallback(await guildCommand('date invalid')))).toContain(
      '멘션 또는 ID'
    )
  })
  it('expands short colors correctly', () => {
    expect(parseRoleColor('#abc')).toBe(0xaabbcc)
    expect(parseRoleColor('#000000')).toBe(0)
    expect(() => parseRoleColor('#abcd')).toThrow()
  })
  it('confirms color once, creates a permissionless role, and reuses only its stored role', async () => {
    const source = await confirmation('color #abc #def')
    expect(createRole).not.toHaveBeenCalled()
    expect(source.flags & MessageFlags.Ephemeral).toBeTruthy()
    const applied = await clickConfirm(source)
    expect(JSON.stringify(getEdit(applied))).toContain('적용했습니다')
    expect(createRole).toHaveBeenCalledWith(
      expect.objectContaining({
        permissions: [],
        colors: { primaryColor: 0xaabbcc, secondaryColor: 0xddeeff }
      })
    )
    expect(getStoredValue(`community:role:${GUILD}:${USER}`)).toBe(ROLE)
    expect(addRole).toHaveBeenCalledTimes(1)
    expect(JSON.stringify(getCallback(await clickConfirm(source)))).toContain('만료된 요청')
    const second = await confirmation('color #123456 --pub')
    await clickConfirm(second)
    expect(editRole).toHaveBeenCalledTimes(1)
    expect(createRole).toHaveBeenCalledTimes(1)
  })
  it('does not let another user confirm or use a copied cross-guild request', async () => {
    const source = await confirmation('color #fff --pub')
    const denied = await clickConfirm(source, OTHER)
    expect(JSON.stringify(getCallback(denied))).toContain('요청한 사용자만')
    const cross = await dispatch(
      buttonJSON(
        source.components,
        COMMUNITY_CONFIRM_ID,
        { ...guildData(), guild_id: OTHER },
        source.flags
      ),
      subs,
      options
    )
    expect(JSON.stringify(getCallback(cross))).toContain('만료된 요청')
    expect(createRole).not.toHaveBeenCalled()
  })
  it('refuses to reuse a recorded role that acquired permissions', async () => {
    setStoredValue(`community:role:${GUILD}:${USER}`, ROLE)
    unsafeStoredRole = true
    const calls = await clickConfirm(await confirmation('color #fff'))
    expect(JSON.stringify(getEdit(calls))).toContain('안전하게 수정할 수 없는 역할')
    expect(editRole).not.toHaveBeenCalled()
    expect(addRole).not.toHaveBeenCalled()
    expect(createRole).not.toHaveBeenCalled()
  })
  it('rejects malformed, corrupt, expired, and newly disabled confirmations', async () => {
    expect(
      JSON.stringify(
        getCallback(await clickConfirm({ components: [], flags: 0 }, USER, 'community-confirm:bad'))
      )
    ).toContain('만료된 요청')
    let source = await confirmation('color #fff')
    const key = listStoredKeys().find((key) => key.startsWith('community:transient:confirm:'))!
    setStoredValue(key, '{}')
    expect(JSON.stringify(getCallback(await clickConfirm(source)))).toContain('만료된 요청')
    source = await confirmation('color #fff')
    vi.advanceTimersByTime(10 * 60_000 + 1)
    expect(JSON.stringify(getCallback(await clickConfirm(source)))).toContain('만료된 요청')
    source = await confirmation('color #fff')
    manageCommunitySettings({
      action: 'update',
      guildId: GUILD,
      settings: { disabledCommands: ['color'] }
    })
    expect(JSON.stringify(getCallback(await clickConfirm(source)))).toContain('비활성화')
    expect(createRole).not.toHaveBeenCalled()
  })
  it('keeps invites private and persists a per-user cooldown', async () => {
    expect(JSON.stringify(getCallback(await guildCommand('invite --pub')))).toContain('비공개')
    const source = await confirmation('invite')
    await clickConfirm(source)
    expect(createInvite).toHaveBeenCalledWith(
      CHANNEL,
      expect.objectContaining({ maxUses: 1, maxAge: 43200, unique: true })
    )
    expect(JSON.stringify(getEdit(await clickConfirm(await confirmation('invite'))))).toContain(
      '대기 시간'
    )
    expect(createInvite).toHaveBeenCalledTimes(1)
    vi.advanceTimersByTime(24 * 3_600_000 + 1)
    await clickConfirm(await confirmation('invite'))
    expect(createInvite).toHaveBeenCalledTimes(2)
  })
  it('blocks public copies of an invite confirmation and allows members without invite permission', async () => {
    const source = await confirmation('invite')
    await clickConfirm({ ...source, flags: MessageFlags.IsComponentsV2 })
    expect(createInvite).not.toHaveBeenCalled()
    await clickConfirm(await confirmation('invite'), USER, COMMUNITY_CONFIRM_ID, '0')
    expect(createInvite).toHaveBeenCalledTimes(1)
  })
  it('sends anonymous text without mentions and deletes the temporary webhook', async () => {
    const calls = await guildCommand('anon @everyone 안녕')
    expect(callbackData(calls).flags & MessageFlags.Ephemeral).toBeTruthy()
    expect(webhookSend).toHaveBeenCalledWith({
      content: '@everyone 안녕',
      allowedMentions: { parse: [] }
    })
    expect(webhookDelete).toHaveBeenCalledTimes(1)
    expect(JSON.stringify(getEdit(calls))).not.toContain('@everyone')
    expect(JSON.stringify(getEdit(calls))).not.toContain('retry')
  })
  it('cleans up the webhook on send failure and warns on cleanup failure', async () => {
    webhookSend.mockRejectedValueOnce(new Error('send failed'))
    await guildCommand('anon message')
    expect(webhookDelete).toHaveBeenCalledTimes(1)
    webhookDelete.mockRejectedValueOnce(new Error('delete failed'))
    expect(JSON.stringify(getEdit(await guildCommand('anon message')))).toContain(
      '웹훅 삭제에 실패'
    )
  })
  it('requires private anonymous invocation regardless of member permissions', async () => {
    const deniedPublic = await guildCommand('anon secret --pub')
    expect(callbackData(deniedPublic).flags & MessageFlags.Ephemeral).toBeTruthy()
    expect(JSON.stringify(deniedPublic)).not.toContain('secret')
    const deniedPermissions = await guildCommand('anon secret --pub', '0')
    expect(callbackData(deniedPermissions).flags & MessageFlags.Ephemeral).toBeTruthy()
    expect(JSON.stringify(deniedPermissions)).not.toContain('secret')
    expect(createWebhook).not.toHaveBeenCalled()
  })
  it('creates a resized emoji without deleting other emojis', async () => {
    fetchMock.mockResolvedValue(
      new Response(new Uint8Array(await createCanvas(200, 100).encode('png')))
    )
    const calls = await guildCommand('emoji smile https://cdn.discordapp.com/attachments/1/2/a.png')
    expect(JSON.stringify(getEdit(calls))).toContain(`<:smile:${ROLE}>`)
    expect(createEmoji).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'smile', attachment: expect.any(Buffer) })
    )
  })
  it('rejects invalid emoji names and untrusted URLs without creating emojis', async () => {
    await guildCommand('emoji x https://cdn.discordapp.com/a')
    await guildCommand('emoji smile https://localhost/a')
    expect(createEmoji).not.toHaveBeenCalled()
    expect(fetchMock).not.toHaveBeenCalled()
  })
})

describe('persisted kick votes', () => {
  it('requires explicit public launch, configured channel, and kickable target', async () => {
    expect(JSON.stringify(getCallback(await guildCommand(`kickvote ${TARGET} spam`)))).toContain(
      '--pub'
    )
    manageCommunitySettings({
      action: 'update',
      guildId: GUILD,
      settings: { kickvoteChannelId: OTHER }
    })
    expect(
      JSON.stringify(getCallback(await guildCommand(`kickvote ${TARGET} spam --pub`)))
    ).toContain(OTHER)
    manageCommunitySettings({ action: 'reset', guildId: GUILD })
    targetProtected = true
    expect(JSON.stringify(getEdit(await guildCommand(`kickvote ${TARGET} spam --pub`)))).toContain(
      '추방할 수 없는'
    )
    expect(kick).not.toHaveBeenCalled()
  })
  it('counts server members, rejects duplicate votes, and kicks exactly once at threshold', async () => {
    const components = await startVote()
    expect(JSON.stringify(getEdit(await vote(components)))).toContain('1/2')
    expect(JSON.stringify(getCallback(await vote(components)))).toContain('이미 투표')
    expect(JSON.stringify(getEdit(await vote(components, OTHER)))).toContain('추방했습니다')
    expect(kick).toHaveBeenCalledTimes(1)
    expect(JSON.stringify(getCallback(await vote(components, OTHER)))).toContain('만료된 투표')
    expect(kick).toHaveBeenCalledTimes(1)
  })
  it('prevents concurrent duplicate votes and duplicate active polls', async () => {
    const components = await startVote()
    await Promise.all([vote(components), vote(components)])
    expect(kick).not.toHaveBeenCalled()
    expect(JSON.stringify(getEdit(await guildCommand(`kickvote ${TARGET} spam --pub`)))).toContain(
      '이미 진행 중'
    )
    await vote(components, OTHER)
    expect(kick).toHaveBeenCalledTimes(1)
  })
  it('rejects target votes, bot votes, malformed IDs, corrupt state, and wrong guilds', async () => {
    const components = await startVote()
    expect(JSON.stringify(getCallback(await vote(components, TARGET)))).toContain('추방 대상자')
    voterBot = true
    await vote(components)
    expect(kick).not.toHaveBeenCalled()
    const malformed = await dispatch(
      buttonJSON([], 'community-kickvote:bad', guildData()),
      subs,
      options
    )
    expect(JSON.stringify(getCallback(malformed))).toContain('만료된 투표')
    const cross = await dispatch(
      buttonJSON(components, KICKVOTE_BUTTON_ID, { ...guildData(), guild_id: OTHER }),
      subs,
      options
    )
    expect(JSON.stringify(getCallback(cross))).toContain('만료된 투표')
    const key = listStoredKeys().find((key) => key.startsWith('community:transient:vote:'))!
    setStoredValue(key, '{broken')
    expect(JSON.stringify(getCallback(await vote(components)))).toContain('만료된 투표')
  })
  it('expires after inactivity and extends the deadline only for accepted votes', async () => {
    const components = await startVote()
    vi.advanceTimersByTime(29 * 60_000)
    await vote(components)
    vi.advanceTimersByTime(2 * 60_000)
    expect(JSON.stringify(getCallback(await vote(components)))).toContain('이미 투표')
    vi.advanceTimersByTime(29 * 60_000)
    expect(JSON.stringify(getCallback(await vote(components, OTHER)))).toContain('만료된 투표')
    expect(kick).not.toHaveBeenCalled()
  })
  it('allows only the owner or moderators to cancel', async () => {
    const components = await startVote()
    const serialized = JSON.stringify(components)
    const cancelId = serialized.match(/community-kickvote:[a-f0-9]{32}:cancel/)![0]
    const denied = await dispatch(
      buttonJSON(components, cancelId, guildData(OTHER, '0')),
      subs,
      options
    )
    expect(JSON.stringify(getCallback(denied))).toContain('개설자 또는')
    const cancelled = await dispatch(
      buttonJSON(components, cancelId, guildData(USER, '0')),
      subs,
      options
    )
    expect(JSON.stringify(getCallback(cancelled))).toContain('취소된 투표')
    expect(JSON.stringify(getCallback(await vote(components)))).toContain('만료된 투표')
  })
  it('closes safely on failed kicks or changed target permissions without retrying the kick', async () => {
    const components = await startVote()
    await vote(components)
    kick.mockRejectedValueOnce(new Error('forbidden'))
    expect(JSON.stringify(getEdit(await vote(components, OTHER)))).toContain('추방에 실패')
    await vote(components, OTHER)
    expect(kick).toHaveBeenCalledTimes(1)
  })
  it('rechecks target protection immediately before a quorum kick', async () => {
    const components = await startVote()
    await vote(components)
    targetProtected = true
    const calls = await vote(components, OTHER)
    expect(JSON.stringify(getEdit(calls))).toContain('추방에 실패')
    expect(kick).not.toHaveBeenCalled()
  })
})
