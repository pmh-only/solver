import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { join } from 'node:path'
import {
  ApplicationCommandType,
  MessageFlags,
  PermissionsBitField,
  type Client,
  type Guild
} from 'discord.js'
import { communityApplicationCommands } from '../community-application-commands.js'
import { applicationCommands, areApplicationCommandsCurrent } from '../application-commands.js'
import { createFeatureRegistry } from '../features.js'
import { COMMUNITY_CONFIRM_ID } from '../commands/community-guild.js'
import { KICKVOTE_BUTTON_ID } from '../commands/kickvote.js'
import { clearStoredValues, listStoredKeys } from '../helpers/kv-store.js'
import { isolateStoredValues } from '../helpers/kv-store-test.js'
import { manageCommunitySettings } from '../community-settings.js'
import {
  agentCommandJSON,
  buttonJSON,
  commandJSON,
  dispatch,
  getCallback,
  getEdit,
  makeSubcommands,
  type RawInteraction,
  type RestCall
} from './e2e.js'

const USER = '555555555555555555' // Deliberately not ADMIN_USER_IDS.
const OTHER = '111111111111111111'
const TARGET = '444444444444444444'
const GUILD = '333333333333333333'
const CHANNEL = '777777777777777777'
const ROLE = '222222222222222222'
const ATTACHMENT = '123456789012345678'
const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  'base64'
)
const kick = vi.fn()
const addRole = vi.fn()
const send = vi.fn()
const channelSend = vi.fn()
const deleteWebhook = vi.fn()
const createInvite = vi.fn()
const createEmoji = vi.fn()
const createRole = vi.fn()
const fetchMock = vi.fn<typeof fetch>()
const subs = makeSubcommands()

function guildData(userId = USER) {
  const user = { id: userId, username: 'ordinary-member', discriminator: '0', avatar: null }
  return {
    guild_id: GUILD,
    channel: { id: CHANNEL },
    user,
    member: { user, permissions: '0', roles: [], joined_at: '2020-01-01T00:00:00Z' }
  }
}
type Option = { name: string; type: number; value: string | boolean; focused?: boolean }
const stringOption = (name: string, value: string): Option => ({ name, value, type: 3 })
const publicOption: Option = { name: 'public', type: 5, value: true }
const userOption = (name: string): Option => ({ name, value: TARGET, type: 6 })
function slashJSON(
  name: string,
  options: Option[] = [],
  overrides: RawInteraction = {}
): RawInteraction {
  return commandJSON('', {
    ...guildData(),
    data: {
      id: '888888888888888888',
      type: 1,
      name,
      options,
      resolved: {
        users: { [TARGET]: { id: TARGET, username: 'target', discriminator: '0', avatar: null } },
        attachments: {
          [ATTACHMENT]: {
            id: ATTACHMENT,
            filename: 'smile.png',
            content_type: 'image/png',
            size: png.length,
            url: 'https://cdn.discordapp.com/attachments/1/2/smile.png',
            proxy_url: 'https://media.discordapp.net/attachments/1/2/smile.png'
          }
        }
      }
    },
    ...overrides
  })
}
function configureClient(client: Client) {
  const guild = (client.guilds as unknown as { _add(data: unknown): Guild })._add({
    id: GUILD,
    name: 'test',
    owner_id: OTHER
  })
  const member = (id: string) => ({
    id,
    user: { id, bot: false, tag: 'ordinary-member' },
    joinedTimestamp: 1577836800000,
    permissions: new PermissionsBitField(),
    kickable: true,
    kick,
    roles: { add: addRole }
  })
  vi.spyOn(guild.members, 'fetch').mockImplementation((async (id: string) => member(id)) as never)
  vi.spyOn(guild.members, 'fetchMe').mockResolvedValue({
    permissions: new PermissionsBitField(['ManageRoles'])
  } as never)
  vi.spyOn(guild.roles, 'create').mockImplementation(createRole)
  vi.spyOn(guild.invites, 'create').mockImplementation(createInvite)
  vi.spyOn(guild.emojis, 'create').mockImplementation(createEmoji)
  vi.spyOn(guild.channels, 'fetch').mockResolvedValue({
    isSendable: () => true,
    send: channelSend,
    createWebhook: vi.fn(async () => ({ send, delete: deleteWebhook }))
  } as never)
}
const options = { configureClient }
function body(calls: RestCall[]): { flags: number; components: unknown[] } {
  return (getEdit(calls) ?? (getCallback(calls) as { data?: unknown } | null)?.data) as {
    flags: number
    components: unknown[]
  }
}
const run = (name: string, args: Option[] = []) => dispatch(slashJSON(name, args), subs, options)
function postedVote(): { components: unknown[]; flags: number } {
  return JSON.parse(JSON.stringify(channelSend.mock.calls.at(-1)![0]))
}
const click = (components: unknown[], prefix: string, flags = 0, user = USER) =>
  dispatch(buttonJSON(components, prefix, guildData(user), flags), subs, options)

beforeEach(() => {
  vi.useFakeTimers()
  isolateStoredValues(join(process.cwd(), '.tmp', 'community-slash.test.sqlite'))
  clearStoredValues()
  manageCommunitySettings({
    action: 'update',
    guildId: GUILD,
    settings: { inviteChannelId: CHANNEL, kickvoteChannelId: CHANNEL }
  })
  vi.clearAllMocks()
  kick.mockResolvedValue(undefined)
  addRole.mockResolvedValue(undefined)
  send.mockResolvedValue(undefined)
  channelSend.mockResolvedValue(undefined)
  deleteWebhook.mockResolvedValue(undefined)
  createInvite.mockResolvedValue({ url: 'https://discord.gg/test' })
  createEmoji.mockResolvedValue({ id: ROLE })
  createRole.mockResolvedValue({ id: ROLE })
  fetchMock
    .mockReset()
    .mockImplementation(
      async (url) =>
        new Response(
          String(url).includes('pizzint.watch') ? '{"defcon_level":3}' : new Uint8Array(png)
        )
    )
  vi.stubGlobal('fetch', fetchMock)
})
afterEach(() => {
  vi.clearAllTimers()
  vi.useRealTimers()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('standalone guild command registration', () => {
  it('registers only guild-installed, guild-context chat-input commands with no permission requirement', () => {
    const registry = createFeatureRegistry(subs)
    for (const definition of communityApplicationCommands) {
      for (const commands of [applicationCommands, registry.commands]) {
        expect(commands.find((command) => command.name === definition.name)).toMatchObject({
          type: ApplicationCommandType.ChatInput,
          integration_types: [0],
          contexts: [0],
          default_member_permissions: null
        })
      }
    }
    expect(
      registry.commands
        .filter(
          (command) =>
            !communityApplicationCommands.some((definition) => definition.name === command.name)
        )
        .every((command) => command.default_member_permissions === '0')
    ).toBe(true)
  })
  it('uses typed user and attachment options, not a /c-style input string', () => {
    expect(
      communityApplicationCommands.find(({ name }) => name === 'emoji')?.options
    ).toContainEqual(expect.objectContaining({ name: 'image', type: 11, required: true }))
    expect(
      communityApplicationCommands.find(({ name }) => name === 'kickvote')?.options
    ).toContainEqual(expect.objectContaining({ name: 'user', type: 6, required: true }))
    expect(
      communityApplicationCommands.every(
        (command) => !command.options?.some((option) => option.name === '_')
      )
    ).toBe(true)
    expect(
      communityApplicationCommands.every(
        (command) => !command.options?.some((option) => option.name === 'public')
      )
    ).toBe(true)
    expect(communityApplicationCommands.find(({ name }) => name === 'invite')?.options).toEqual([])
  })
  it.each(['contexts', 'integration_types', 'default_member_permissions'])(
    'detects stale %s on previously registered commands',
    (field) => {
      const current = applicationCommands.map((command) => ({
        ...command,
        type: command.type ?? ApplicationCommandType.ChatInput
      }))
      expect(areApplicationCommandsCurrent(current)).toBe(true)
      const stale = current.map((command) =>
        command.name === 'food'
          ? { ...command, [field]: field === 'default_member_permissions' ? '0' : [1] }
          : command
      )
      expect(areApplicationCommandsCurrent(stale)).toBe(false)
    }
  )
  it('does not grant ordinary members access to /c or /a', async () => {
    expect(await dispatch(commandJSON('food', guildData()), subs, options)).toEqual([])
    expect(await dispatch(agentCommandJSON('test', guildData()), subs, options)).toEqual([])
  })
})

describe('standalone commands called by ordinary guild members', () => {
  it.each(['invite', 'kickvote'] as const)(
    'restricts /%s to its configured channel',
    async (name) => {
      const args = name === 'kickvote' ? [userOption('user'), stringOption('reason', '스팸')] : []
      for (const channelId of [null, OTHER]) {
        manageCommunitySettings({
          action: 'update',
          guildId: GUILD,
          settings: { [name === 'invite' ? 'inviteChannelId' : 'kickvoteChannelId']: channelId }
        })
        const calls = await run(name, args)
        expect(JSON.stringify(body(calls))).toContain(channelId ?? '/a')
        expect(body(calls).flags & MessageFlags.Ephemeral).toBeTruthy()
      }
      expect(createInvite).not.toHaveBeenCalled()
      expect(kick).not.toHaveBeenCalled()
      expect(channelSend).not.toHaveBeenCalled()
    }
  )
  it('rechecks the invite channel when confirming an existing request', async () => {
    const source = body(await run('invite'))
    manageCommunitySettings({
      action: 'update',
      guildId: GUILD,
      settings: { inviteChannelId: OTHER }
    })
    const denied = await click(source.components, COMMUNITY_CONFIRM_ID, source.flags)
    expect(JSON.stringify(body(denied))).toContain(OTHER)
    expect(createInvite).not.toHaveBeenCalled()
    expect(channelSend).not.toHaveBeenCalled()
  })
  it.each([null, OTHER])(
    'blocks existing kickvote buttons after changing the channel to %s',
    async (channelId) => {
      await run('kickvote', [userOption('user'), stringOption('reason', '스팸')])
      const source = postedVote()
      manageCommunitySettings({
        action: 'update',
        guildId: GUILD,
        settings: { kickvoteChannelId: channelId }
      })
      const denied = await click(source.components, KICKVOTE_BUTTON_ID, source.flags)
      expect(JSON.stringify(body(denied))).toContain('설정된 투표 채널이 아닙니다.')
      expect(kick).not.toHaveBeenCalled()
    }
  )
  it.each(['food', 'foods', '점메추', '저메추', 'pizza', 'now', 'date', 'help'])(
    'allows /%s with zero guild permissions',
    async (name) => {
      const calls = await run(name)
      expect(calls.length).toBeGreaterThan(0)
      expect(JSON.stringify(body(calls))).toContain('components')
      expect(body(calls).flags & MessageFlags.IsComponentsV2).toBeTruthy()
      const callback = getCallback(calls) as { data: { flags?: number } }
      expect((callback.data.flags ?? 0) & MessageFlags.Ephemeral).toBe(0)
      expect(JSON.stringify(body(calls))).not.toMatch(
        /retry:|edit-parameters|command-actions|command-presets|run-command/
      )
    }
  )
  it('returns typed filter results publicly without an option or /c retry state', async () => {
    const calls = await run('food', [stringOption('filter', '멕시칸 치즈')])
    expect(JSON.stringify(body(calls))).toContain('퀘사디아')
    expect((getCallback(calls) as { data: { flags?: number } }).data.flags ?? 0).toBe(0)
    expect(listStoredKeys().filter((key) => /^(command-input|message-input):/.test(key))).toEqual(
      []
    )
  })
  it('does not let stale public:false options make server responses private', async () => {
    const calls = await run('food', [
      stringOption('filter', '멕시칸 치즈'),
      { ...publicOption, value: false }
    ])
    expect(JSON.stringify(body(calls))).toContain('퀘사디아')
    expect(
      ((getCallback(calls) as { data: { flags?: number } }).data.flags ?? 0) &
        MessageFlags.Ephemeral
    ).toBe(0)
    expect(listStoredKeys().filter((key) => /^(command-input|message-input):/.test(key))).toEqual(
      []
    )
  })
  it('detects previously registered public options as stale', () => {
    const stale = applicationCommands.map((command) => ({
      ...command,
      type: command.type ?? ApplicationCommandType.ChatInput,
      options:
        command.name === 'food'
          ? [...(command.options ?? []), { name: 'public', type: 5, description: '공개 응답' }]
          : command.options
    }))
    expect(areApplicationCommandsCurrent(stale)).toBe(false)
  })
  it.each(['food', 'pizza', 'now', 'date', 'color', 'emoji', 'help'])(
    'does not advertise public options in /help command:%s',
    async (name) => {
      const calls = await run('help', [stringOption('command', name)])
      expect(JSON.stringify(body(calls))).not.toContain('public:true')
    }
  )
  it('resolves user options for /date', async () => {
    const calls = await run('date', [userOption('member')])
    expect(JSON.stringify(body(calls))).toContain(TARGET)
    expect(JSON.stringify(body(calls))).toContain('<t:1577836800:F>')
  })
  it('lets an ordinary member confirm their own role color, but not somebody else', async () => {
    const source = body(
      await run('color', [stringOption('hex', '#abc'), stringOption('secondary', '#def')])
    )
    expect(source.flags & MessageFlags.Ephemeral).toBe(0)
    const denied = await click(source.components, COMMUNITY_CONFIRM_ID, source.flags, OTHER)
    expect(JSON.stringify(body(denied))).toContain('요청한 사용자만')
    const confirmed = body(await click(source.components, COMMUNITY_CONFIRM_ID, source.flags))
    expect(confirmed.flags & MessageFlags.Ephemeral).toBe(0)
    expect(createRole).toHaveBeenCalledWith(
      expect.objectContaining({
        permissions: [],
        colors: { primaryColor: 0xaabbcc, secondaryColor: 0xddeeff }
      })
    )
    expect(addRole).toHaveBeenCalledTimes(1)
    expect(
      JSON.stringify(body(await click(source.components, COMMUNITY_CONFIRM_ID, source.flags)))
    ).toContain('만료된 요청')
  })
  it('lets an ordinary member create a private invite after confirmation and enforces cooldown', async () => {
    let source = body(await run('invite', [publicOption]))
    expect(source.flags & MessageFlags.Ephemeral).toBeTruthy()
    const calls = await click(source.components, COMMUNITY_CONFIRM_ID, source.flags)
    // A deferred update preserves the source message's ephemeral visibility.
    expect(getCallback(calls)).toMatchObject({ type: 6 })
    expect(JSON.stringify(body(calls))).toContain('https://discord.gg/test')
    expect(channelSend).toHaveBeenCalledTimes(1)
    expect(JSON.stringify(channelSend.mock.calls[0])).toContain(
      '`ordinary-member`가 1회용 초대 링크를 생성했어요!'
    )
    expect(JSON.stringify(channelSend.mock.calls[0])).not.toContain('https://discord.gg/')
    expect(channelSend).toHaveBeenCalledWith(
      expect.objectContaining({ allowedMentions: { parse: [], repliedUser: false } })
    )
    expect(createInvite).toHaveBeenCalledWith(
      CHANNEL,
      expect.objectContaining({ maxUses: 1, maxAge: 43200 })
    )
    source = body(await run('invite'))
    expect(
      JSON.stringify(body(await click(source.components, COMMUNITY_CONFIRM_ID, source.flags)))
    ).toContain('대기 시간')
    expect(createInvite).toHaveBeenCalledTimes(1)
    expect(channelSend).toHaveBeenCalledTimes(1)
  })
  it('keeps a created invite private and reports a failed public notice without creating it twice', async () => {
    channelSend.mockRejectedValueOnce(new Error('private Discord API failure'))
    const source = body(await run('invite'))
    const calls = await click(source.components, COMMUNITY_CONFIRM_ID, source.flags)
    expect(JSON.stringify(body(calls))).toContain('https://discord.gg/test')
    expect(JSON.stringify(body(calls))).toContain('알림을 보내지 못했습니다.')
    expect(JSON.stringify(body(calls))).not.toContain('private Discord API failure')
    await click(source.components, COMMUNITY_CONFIRM_ID, source.flags)
    expect(createInvite).toHaveBeenCalledTimes(1)
    expect(channelSend).toHaveBeenCalledTimes(1)
  })
  it('lets an ordinary member send an anonymous message, preserving --flags as message text', async () => {
    const calls = await run('anon', [
      stringOption('message', '안녕하세요 --pub @everyone'),
      publicOption
    ])
    expect(send).toHaveBeenCalledWith({
      content: '안녕하세요 --pub @everyone',
      allowedMentions: { parse: [] }
    })
    expect(deleteWebhook).toHaveBeenCalledTimes(1)
    expect(JSON.stringify(body(calls))).not.toContain('@everyone')
    expect(
      (getCallback(calls) as { data: { flags: number } }).data.flags & MessageFlags.Ephemeral
    ).toBeTruthy()
  })
  it('lets an ordinary member upload an emoji attachment', async () => {
    const calls = await run('emoji', [
      stringOption('name', 'smile'),
      { name: 'image', type: 11, value: ATTACHMENT }
    ])
    expect(createEmoji).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'smile', attachment: expect.any(Buffer) })
    )
    expect(JSON.stringify(body(calls))).toContain(`<:smile:${ROLE}>`)
    expect(
      ((getCallback(calls) as { data: { flags?: number } }).data.flags ?? 0) &
        MessageFlags.Ephemeral
    ).toBe(0)
  })
  it('lets ordinary members start and participate in a public kick vote, not cancel another member’s vote', async () => {
    manageCommunitySettings({
      action: 'update',
      guildId: GUILD,
      settings: { kickvoteThreshold: 2 }
    })
    const calls = await run('kickvote', [userOption('user'), stringOption('reason', '스팸 --pub')])
    expect(
      (getCallback(calls) as { data: { flags: number } }).data.flags & MessageFlags.Ephemeral
    ).toBeTruthy()
    expect(JSON.stringify(body(calls))).toContain('추방 투표를 시작했어요!')
    const source = postedVote()
    expect(source.flags & MessageFlags.Ephemeral).toBeFalsy()
    expect(JSON.stringify(source)).toContain('스팸 --pub')
    const cancelId = JSON.stringify(source).match(/community-kickvote:[a-f0-9]{32}:cancel/)![0]
    expect(
      JSON.stringify(body(await click(source.components, cancelId, source.flags, OTHER)))
    ).toContain('개설자 또는')
    await click(source.components, KICKVOTE_BUTTON_ID)
    await click(source.components, KICKVOTE_BUTTON_ID, 0, OTHER)
    expect(kick).toHaveBeenCalledTimes(1)
  })
  it('serves independent help and help autocomplete without exposing /c controls', async () => {
    const help = body(await run('help', [stringOption('command', 'emoji')]))
    expect(JSON.stringify(help)).toContain('/emoji')
    expect(JSON.stringify(help)).not.toContain('/c ')
    const raw = slashJSON('help', [{ ...stringOption('command', 'ki'), focused: true }], {
      type: 4
    })
    expect(getCallback(await dispatch(raw, subs, options))).toMatchObject({
      type: 8,
      data: { choices: [{ name: 'kickvote', value: 'kickvote' }] }
    })
  })
  it.each(communityApplicationCommands.map(({ name }) => name))(
    'refuses /%s outside a guild, even if a user-install interaction is forged',
    async (name) => {
      const raw = slashJSON(name, [], { guild_id: undefined, member: undefined, context: 1 })
      const calls = await dispatch(raw, subs, options)
      expect(JSON.stringify(body(calls))).toContain('서버에서만')
      expect(body(calls).flags & MessageFlags.Ephemeral).toBeTruthy()
    }
  )
  it('respects /a-managed disabling for ordinary users and private components', async () => {
    const source = body(await run('color', [stringOption('hex', '#fff')]))
    manageCommunitySettings({
      action: 'update',
      guildId: GUILD,
      settings: { disabledCommands: ['color', 'food'] }
    })
    expect(JSON.stringify(body(await run('food')))).toContain('비활성화')
    expect(
      JSON.stringify(body(await click(source.components, COMMUNITY_CONFIRM_ID, source.flags)))
    ).toContain('비활성화')
    expect(createRole).not.toHaveBeenCalled()
  })
})
