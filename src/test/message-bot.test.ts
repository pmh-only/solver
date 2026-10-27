import { join } from 'node:path'
import { ChannelType, type Client, type Guild } from 'discord.js'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createMessageHandler } from '../message-handler.js'
import { createMessageBotHandler, fetchMessageBotJson } from '../commands/message-bot/runtime.js'
import { manageCommunitySettings } from '../community-settings.js'
import { clearStoredValues, getStoredValue, setStoredValue } from '../helpers/kv-store.js'
import { isolateStoredValues } from '../helpers/kv-store-test.js'
import {
  dispatchMessage,
  commandJSON,
  dispatch,
  getCallback,
  makeSubcommands,
  type RestCall
} from './e2e.js'
import { subcommand as list } from '../commands/list.js'

const GUILD = '333333333333333333'
const OTHER_GUILD = '222222222222222222'
const CHANNEL = '777777777777777777'
const USER = '555555555555555555'
const OTHER_USER = '444444444444444444'
const fetchMock = vi.fn<typeof fetch>()

function configureClient(client: Client) {
  for (const id of [GUILD, OTHER_GUILD]) {
    const guild = (client.guilds as unknown as { _add(data: unknown): Guild })._add({
      id,
      name: 'test',
      owner_id: USER
    })
    ;(client.channels as unknown as { _add(data: unknown, guild: Guild): unknown })._add(
      {
        id: id === GUILD ? CHANNEL : OTHER_GUILD,
        guild_id: id,
        type: ChannelType.GuildText,
        name: 'general',
        permission_overwrites: []
      },
      guild
    )
  }
}
function rawMessage(content: string, overrides: Record<string, unknown> = {}) {
  return {
    id: '1000000000000000001',
    guild_id: GUILD,
    channel_id: CHANNEL,
    type: 0,
    content,
    author: { id: USER, username: 'ordinary-member', discriminator: '0', avatar: null, bot: false },
    mentions: [],
    mention_roles: [],
    attachments: [],
    embeds: [],
    components: [],
    flags: 0,
    timestamp: '2026-10-27T00:00:00.000Z',
    ...overrides
  }
}
const options = {
  configureClient,
  postResult: () => ({
    id: '1000000000000000002',
    type: 0,
    channel_id: CHANNEL,
    content: '',
    embeds: [],
    components: [],
    attachments: [],
    flags: 0,
    author: {
      id: '999999999999999999',
      username: 'solver',
      discriminator: '0',
      avatar: null,
      bot: true
    }
  })
}
const run = (content: string, overrides: Record<string, unknown> = {}) =>
  dispatchMessage(rawMessage(content, overrides), options)
function replies(calls: RestCall[]): string[] {
  return calls
    .filter((call) => call.method === 'POST' && /^\/channels\/\d+\/messages$/.test(call.route))
    .map((call) => (call.body as { content: string }).content)
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-10-27T00:00:00Z'))
  isolateStoredValues(join(process.cwd(), '.tmp', 'message-bot.test.sqlite'))
  clearStoredValues()
  vi.spyOn(Math, 'random').mockReturnValue(0)
  fetchMock.mockReset().mockImplementation(async (url) => {
    const target = String(url)
    if (target === 'https://www.pizzint.watch/api/dashboard-data?nocache=1')
      return new Response('{"defcon_level":3}')
    if (target.endsWith('/usd.json')) return new Response('{"usd":{"krw":1400,"eur":0.9,"zero":0}}')
    return new Response('{}', { status: 404 })
  })
  vi.stubGlobal('fetch', fetchMock)
})
afterEach(() => {
  vi.clearAllTimers()
  vi.useRealTimers()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('original pmh-only/bot message commands', () => {
  it('keeps !!ping output and disables every kind of reply mention', async () => {
    const calls = await run('!!ping')
    expect(replies(calls)).toEqual(['pong!'])
    const reply = calls.find((call) => call.method === 'POST')?.body
    expect(reply).toMatchObject({
      allowed_mentions: { parse: [], replied_user: false },
      message_reference: { message_id: '1000000000000000001' }
    })
    expect(reply).not.toHaveProperty('components', expect.any(Array))
  })
  it('keeps the original Date string, epoch and relative timestamp format', async () => {
    const date = new Date()
    expect(replies(await run('!!now'))).toEqual([
      `${date} (${date.getTime()}) <t:${Math.floor(date.getTime() / 1000)}:R>`
    ])
  })
  it('keeps the exact original help text and command grammar', async () => {
    expect(replies(await run('!!help'))).toEqual([
      [
        '!!help - show commands',
        '!!ping - pong',
        '!!now - current time',
        '!!set <match> [...reply] - add or delete a set command',
        '!!list - list set command keys',
        '!!pizza - show pizza index',
        '!!<amount> <currency> to <currency> - convert currencies',
        '점메추 / 저메추 - random food'
      ].join('\n')
    ])
  })
  it.each(['!!1 usd to krw', '!!1usd to krw', '!!2.5 usd to krw'])(
    'keeps original currency parsing and multiplication: %s',
    async (input) => {
      expect(replies(await run(input))).toEqual([`${input.includes('2.5') ? 3500 : 1400} krw`])
    }
  )
  it.each([
    '!!0 usd to krw',
    '!!1 usd to zero',
    '!!1 USD to krw',
    '!!1 usd TO krw',
    '!!bad to krw'
  ])('preserves silent invalid, case-sensitive and falsy-result behavior: %s', async (input) => {
    expect(replies(await run(input))).toEqual([])
  })
  it('keeps the exact original pizza output', async () => {
    expect(replies(await run('!!pizza'))).toEqual([
      ':pizza: PIZZA INDEX\n> **DEFCON 3**\n-# <https://www.pizzint.watch>'
    ])
  })
  it.each(['점메추', '저메추'])(
    'keeps the exact random food and tag output for %s',
    async (input) => {
      expect(replies(await run(input))).toEqual(['치킨 #한식 #야식 #안주 #배달'])
      expect(fetchMock).not.toHaveBeenCalled()
    }
  )
  it('uses the same random indexing with a /a-configured menu', async () => {
    manageCommunitySettings({
      action: 'update',
      guildId: GUILD,
      settings: {
        foods: [
          { name: 'one', tags: ['a'] },
          { name: 'two', tags: ['b'] }
        ]
      }
    })
    vi.mocked(Math.random).mockReturnValue(0.99)
    expect(replies(await run('점메추'))).toEqual(['two #b'])
  })
  it.each(['!!PING', '!!ping ', ' 점메추', '점메추 ', '!ping', 'hello'])(
    'preserves exact content matching: %s',
    async (input) => {
      expect(replies(await run(input))).toEqual([])
    }
  )
  it('supports adding, overwriting, recalling and deleting set replies with original author attribution', async () => {
    expect(replies(await run('!!set'))).toEqual(['!!set <match> [...reply]'])
    expect(replies(await run('!!set greeting hello  world'))).toEqual(['greeting added'])
    expect(replies(await run('!!greeting'))).toEqual([`hello  world\n-# <@${USER}>`])
    expect(
      replies(
        await run('!!set greeting next', {
          author: { id: OTHER_USER, username: 'other', discriminator: '0', bot: false }
        })
      )
    ).toEqual(['greeting added'])
    expect(replies(await run('!!greeting'))).toEqual([`next\n-# <@${OTHER_USER}>`])
    expect(replies(await run('!!set greeting'))).toEqual(['greeting deleted'])
    expect(replies(await run('!!greeting'))).toEqual([])
  })
  it('keeps sorted lists, reserved help/list keys and builtin-key coexistence', async () => {
    expect(replies(await run('!!list'))).toEqual(['no set commands'])
    await run('!!set z last')
    await run('!!set a first')
    expect(replies(await run('!!list'))).toEqual(['!!a\n!!z'])
    expect(replies(await run('!!set help hidden'))).toEqual(['help deleted'])
    expect(replies(await run('!!set list hidden'))).toEqual(['list deleted'])
    await run('!!set ping custom')
    expect(replies(await run('!!ping'))).toEqual(['pong!', `custom\n-# <@${USER}>`])
  })
  it('persists per guild across handler instances without reading /c variables or secrets', async () => {
    setStoredValue('secret', 'private /c data')
    await run('!!set answer 42')
    expect(replies(await run('!!answer'))).toEqual([`42\n-# <@${USER}>`])
    expect(
      replies(await run('!!answer', { guild_id: OTHER_GUILD, channel_id: OTHER_GUILD }))
    ).toEqual([])
    expect(replies(await run('!!secret'))).toEqual([])
    expect(getStoredValue('secret')).toBe('private /c data')
    const listCalls = await dispatch(commandJSON('list community'), makeSubcommands(list))
    expect(JSON.stringify(getCallback(listCalls))).not.toContain('message-bot:')
  })
  it('does not lose overlapping set operations', async () => {
    await Promise.all([run('!!set first one'), run('!!set second two')])
    expect(replies(await run('!!list'))).toEqual(['!!first\n!!second'])
  })
  it('configures prefix and enablement immediately through /a, including regex punctuation', async () => {
    manageCommunitySettings({
      action: 'update',
      guildId: GUILD,
      settings: { messageCommands: { enabled: true, prefix: '$!' } }
    })
    expect(replies(await run('$!ping'))).toEqual(['pong!'])
    expect(replies(await run('$!1usd to krw'))).toEqual(['1400 krw'])
    expect(replies(await run('!!ping'))).toEqual([])
    manageCommunitySettings({
      action: 'update',
      guildId: GUILD,
      settings: { messageCommands: { enabled: false } }
    })
    expect(replies(await run('!!ping'))).toEqual([])
    expect(replies(await run('점메추'))).toEqual([])
  })
  it('ignores bot, webhook, system and DM messages', async () => {
    for (const overrides of [
      { author: { id: USER, username: 'bot', discriminator: '0', bot: true } },
      { webhook_id: USER },
      { type: 7 },
      { guild_id: undefined, channel_id: '888888888888888888' }
    ])
      expect(replies(await run('!!ping', overrides))).toEqual([])
  })
  it('recovers corrupt records through /a without clearing other server settings', async () => {
    setStoredValue(`community:message-bot:${GUILD}`, '{broken')
    expect(replies(await run('!!list')).some((reply) => reply.startsWith('error: '))).toBe(true)
    manageCommunitySettings({ action: 'reset-message-replies', guildId: GUILD })
    expect(replies(await run('!!list'))).toEqual(['no set commands'])
  })
  it('bounds long replies and prevents prototype-key writes', async () => {
    await run('!!set long ' + 'a'.repeat(3000))
    const long = replies(await run('!!long'))[0]!
    expect(long).toHaveLength(2000)
    expect(long.endsWith('…')).toBe(true)
    expect(
      replies(await run('!!set __proto__ polluted')).some((reply) => reply.startsWith('error: '))
    ).toBe(true)
    expect({}).not.toHaveProperty('polluted')
  })
  it('bounds persistent records without discarding existing replies', async () => {
    const records = Object.fromEntries(
      Array.from({ length: 1000 }, (_, index) => [
        String(index),
        { content: 'saved', authorId: USER }
      ])
    )
    setStoredValue(`community:message-bot:${GUILD}`, JSON.stringify(records))
    const calls = await run('!!set overflow new')
    expect(replies(calls).some((reply) => reply.startsWith('error: '))).toBe(true)
    expect(JSON.parse(getStoredValue(`community:message-bot:${GUILD}`)!)).toEqual(records)
    expect(replies(await run('!!0'))).toEqual([`saved\n-# <@${USER}>`])
  })
  it('routes original commands ahead of role chat and leaves ordinary messages for role chat', async () => {
    const roleChat = vi.fn().mockResolvedValue(undefined)
    const handler = createMessageHandler(createMessageBotHandler(), roleChat)
    await dispatchMessage(rawMessage('!!ping'), options, handler)
    expect(roleChat).not.toHaveBeenCalled()
    await dispatchMessage(rawMessage('ordinary chat'), options, handler)
    expect(roleChat).toHaveBeenCalledTimes(1)
  })
})

describe('message-command network boundaries', () => {
  it('uses bounded, non-redirecting requests to the original endpoints', async () => {
    const result = await fetchMessageBotJson(
      'https://cdn.jsdelivr.net/npm/@fawazahmed0/currency-api@latest/v1/currencies/usd.json'
    )
    expect(await result.json()).toMatchObject({ usd: { krw: 1400 } })
    expect(fetchMock).toHaveBeenCalledWith(expect.any(URL), {
      redirect: 'error',
      signal: expect.any(AbortSignal)
    })
  })
  it.each([
    'http://127.0.0.1/data.json',
    'https://cdn.jsdelivr.net/other.json',
    'https://www.pizzint.watch/other',
    'https://evil.example/currencies/usd.json'
  ])('rejects unexpected data destinations: %s', async (url) => {
    await expect(fetchMessageBotJson(url)).rejects.toThrow()
    expect(fetchMock).not.toHaveBeenCalled()
  })
  it('handles conversion failure silently, while pizza failures retain an error reply', async () => {
    fetchMock.mockRejectedValue(new Error('service unavailable'))
    expect(replies(await run('!!1 usd to krw'))).toEqual([])
    expect(replies(await run('!!pizza'))).toEqual(['error: service unavailable'])
  })
  it('rejects oversized and malformed responses without unlimited downloads', async () => {
    fetchMock.mockResolvedValue(new Response('x', { headers: { 'content-length': '2000000' } }))
    await expect(
      fetchMessageBotJson('https://www.pizzint.watch/api/dashboard-data?nocache=1')
    ).rejects.toThrow()
    fetchMock.mockResolvedValue(new Response('not json'))
    const response = await fetchMessageBotJson(
      'https://www.pizzint.watch/api/dashboard-data?nocache=1'
    )
    await expect(response.json()).rejects.toThrow()
  })
  it('never follows a redirect to a private destination', async () => {
    fetchMock.mockResolvedValue(
      new Response('', { status: 302, headers: { location: 'http://127.0.0.1/' } })
    )
    await expect(
      fetchMessageBotJson('https://www.pizzint.watch/api/dashboard-data?nocache=1')
    ).rejects.toThrow()
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(fetchMock).toHaveBeenCalledWith(
      expect.any(URL),
      expect.objectContaining({ redirect: 'error' })
    )
  })
  it('passes the explicit timeout signal and releases failed transfers after cancellation', async () => {
    const controller = new AbortController()
    const timeout = vi.spyOn(AbortSignal, 'timeout').mockReturnValue(controller.signal)
    fetchMock.mockImplementationOnce(
      (_url, options) =>
        new Promise((_resolve, reject) => {
          options?.signal?.addEventListener('abort', () => reject(new Error('timed out')), {
            once: true
          })
        })
    )
    const pending = fetchMessageBotJson('https://www.pizzint.watch/api/dashboard-data?nocache=1')
    const failure = expect(pending).rejects.toThrow('timed out')
    expect(timeout).toHaveBeenCalledWith(10000)
    controller.abort()
    await failure
    fetchMock.mockResolvedValue(new Response('{"defcon_level":3}'))
    expect(
      await (
        await fetchMessageBotJson('https://www.pizzint.watch/api/dashboard-data?nocache=1')
      ).json()
    ).toEqual({ defcon_level: 3 })
  })
})
