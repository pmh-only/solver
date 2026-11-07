import { join } from 'node:path'
import { Collection, type Message } from 'discord.js'
import { beforeEach, afterEach, expect, it, vi } from 'vitest'
import { createMemeSearchHandler, findMemeContent } from '../meme-search.js'
import { createMessageHandler } from '../message-handler.js'
import { manageCommunitySettings, loadCommunitySettings } from '../community-settings.js'
import { clearStoredValues } from '../helpers/kv-store.js'
import { isolateStoredValues } from '../helpers/kv-store-test.js'
const ROLE = '123456789012345678'
const ID = '08dce137-3f2d-4b75-8319-c1787d530267'
const image = 'https://s3.lth.so/memehub/file?signature=test'
const fetchMock = vi.fn<typeof fetch>()

function fixture() {
  const send = vi.fn().mockResolvedValue({ id: 'sent' })
  const hook = { name: 'solver-meme', owner: { id: 'bot' }, token: 'secret', send }
  const channel = {
    id: 'channel',
    isThread: () => false,
    permissionsFor: () => ({ has: () => true }),
    fetchWebhooks: vi.fn().mockResolvedValue(new Collection([['hook', hook]])),
    createWebhook: vi.fn().mockResolvedValue(hook)
  }
  const message = {
    id: 'message',
    guildId: 'guild',
    content: `<@&${ROLE}> gp2 engine`,
    author: {
      id: 'user',
      username: 'username',
      bot: false,
      displayAvatarURL: () => 'https://cdn.discordapp.com/avatar.png'
    },
    member: {
      displayName: 'nickname',
      displayAvatarURL: () => 'https://cdn.discordapp.com/guild-avatar.png'
    },
    client: { user: { id: 'bot' } },
    channel,
    attachments: new Collection(),
    deletable: true,
    delete: vi.fn().mockResolvedValue(undefined)
  }
  return { message, channel, send }
}
beforeEach(() => {
  isolateStoredValues(join(process.cwd(), '.tmp', 'meme-search.test.sqlite'))
  clearStoredValues()
  manageCommunitySettings({ action: 'update', settings: { memeSearch: { roleId: ROLE } } })
  vi.stubGlobal('fetch', fetchMock)
  fetchMock.mockReset()
})
afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

it('configures and disables meme search through persisted /a settings', () => {
  expect(loadCommunitySettings().memeSearch).toEqual({ roleId: ROLE })
  expect(() =>
    manageCommunitySettings({ action: 'update', settings: { memeSearch: { roleId: 'bad' } } })
  ).toThrow()
  manageCommunitySettings({ action: 'update', settings: { memeSearch: null } })
  expect(loadCommunitySettings().memeSearch).toBeNull()
})
it('returns the image URL with only two API requests and no image download', async () => {
  fetchMock
    .mockResolvedValueOnce(Response.json({ items: [{ id: ID, content_type: 'image' }] }))
    .mockResolvedValueOnce(
      Response.json({ original: { url: 'https://s3.lth.so/memehub/file?signature=test' } })
    )
  expect(await findMemeContent('gp2 engine')).toBe(image)
  expect(fetchMock).toHaveBeenCalledTimes(2)
  expect(String(fetchMock.mock.calls[0][0])).toContain('q=gp2+engine')
  expect(new URL(String(fetchMock.mock.calls[0][0])).searchParams.has('content_type')).toBe(false)
  expect(fetchMock.mock.calls[0][1]).toMatchObject({
    redirect: 'error',
    signal: expect.any(AbortSignal)
  })
})
it('stops after the search request when there are no results', async () => {
  fetchMock.mockResolvedValueOnce(Response.json({ items: [] }))
  expect(await findMemeContent('missing')).toBeNull()
  expect(fetchMock).toHaveBeenCalledOnce()
})
it('returns audio URLs without downloading or re-uploading media', async () => {
  fetchMock
    .mockResolvedValueOnce(Response.json({ items: [{ id: ID, content_type: 'audio' }] }))
    .mockResolvedValueOnce(Response.json({ original: { url: image } }))
  const { message, send } = fixture()
  await createMemeSearchHandler()(message as unknown as Message)
  expect(fetchMock).toHaveBeenCalledTimes(2)
  expect(String(fetchMock.mock.calls[1][0])).toBe(`https://meme.lth.so/api/memes/${ID}/media`)
  expect(send.mock.calls[0][0]).toMatchObject({ content: image })
  expect(message.delete).toHaveBeenCalledOnce()
})
it('sends text bodies verbatim without a media request or mention notifications', async () => {
  const body = '첫 줄\n@everyone <@123456789012345678> **밈**'
  fetchMock.mockResolvedValueOnce(
    Response.json({ items: [{ id: ID, content_type: 'text', body_text: body }] })
  )
  const { message, send } = fixture()
  await createMemeSearchHandler()(message as unknown as Message)
  expect(fetchMock).toHaveBeenCalledOnce()
  expect(send.mock.calls[0][0]).toMatchObject({
    content: body,
    allowedMentions: { parse: [], repliedUser: false }
  })
  expect(message.delete).toHaveBeenCalledOnce()
})
it.each([2000, 2001, 10_000])(
  'bounds %i-character text to the Discord content limit',
  async (size) => {
    fetchMock.mockResolvedValueOnce(
      Response.json({ items: [{ id: ID, content_type: 'text', body_text: '가'.repeat(size) }] })
    )
    expect(await findMemeContent('query')).toBe(
      size > 2000 ? `${'가'.repeat(1999)}…` : '가'.repeat(size)
    )
    expect(fetchMock).toHaveBeenCalledOnce()
  }
)
it.each([undefined, null, '', ' \n ', 123, 'x'.repeat(10_001)])(
  'preserves the original when text body is invalid (case %#)',
  async (body) => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    fetchMock.mockResolvedValueOnce(
      Response.json({ items: [{ id: ID, content_type: 'text', body_text: body }] })
    )
    const { message, send } = fixture()
    await createMemeSearchHandler()(message as unknown as Message)
    expect(send).not.toHaveBeenCalled()
    expect(message.delete).not.toHaveBeenCalled()
    expect(fetchMock).toHaveBeenCalledOnce()
  }
)
it.each(['http://s3.lth.so/file', 'https://127.0.0.1/file', 'https://s3.lth.so.evil.test/file'])(
  'rejects unsafe media %s',
  async (url) => {
    fetchMock
      .mockResolvedValueOnce(Response.json({ items: [{ id: ID, content_type: 'image' }] }))
      .mockResolvedValueOnce(Response.json({ original: { url } }))
    await expect(findMemeContent('query')).rejects.toThrow()
    expect(fetchMock).toHaveBeenCalledTimes(2)
  }
)
it.each(['malformed', 'oversized', 'timeout', 'http'])('rejects %s API responses', async (kind) => {
  if (kind === 'timeout')
    fetchMock.mockRejectedValueOnce(new DOMException('timeout', 'TimeoutError'))
  else
    fetchMock.mockResolvedValueOnce(
      kind === 'http'
        ? new Response('', { status: 503 })
        : new Response(kind === 'oversized' ? 'x'.repeat(256 * 1024 + 1) : '{}')
    )
  await expect(findMemeContent('query')).rejects.toThrow()
})
it('reuses an owned webhook with author identity, suppresses mentions and deletes only after send', async () => {
  const { message, channel, send } = fixture()
  send.mockImplementation(async () => {
    expect(message.delete).not.toHaveBeenCalled()
  })
  const find = vi.fn().mockResolvedValue(image)
  const handle = createMemeSearchHandler(find)
  expect(await handle(message as unknown as Message)).toBe(true)
  expect(find).toHaveBeenCalledWith('gp2 engine')
  expect(send).toHaveBeenCalledWith({
    username: 'nickname',
    avatarURL: 'https://cdn.discordapp.com/guild-avatar.png',
    content: image,
    allowedMentions: { parse: [], repliedUser: false }
  })
  expect(channel.createWebhook).not.toHaveBeenCalled()
  expect(message.delete).toHaveBeenCalledOnce()
  await handle(message as unknown as Message)
  expect(send).toHaveBeenCalledOnce()
})
it('creates a webhook if needed and targets threads through their parent', async () => {
  const { message, channel, send } = fixture()
  channel.fetchWebhooks.mockResolvedValue(new Collection())
  message.channel = {
    id: 'thread',
    isThread: () => true,
    parent: channel
  } as unknown as typeof channel
  await createMemeSearchHandler(async () => image)(message as unknown as Message)
  expect(channel.createWebhook).toHaveBeenCalledWith({ name: 'solver-meme' })
  expect(send.mock.calls[0][0]).toMatchObject({ threadId: 'thread' })
})
it.each(['missing', 'lookup', 'send'])('preserves originals on %s failure', async (kind) => {
  vi.spyOn(console, 'error').mockImplementation(() => {})
  const { message, send } = fixture()
  if (kind === 'send') send.mockRejectedValueOnce(new Error('secret'))
  const find = vi.fn().mockResolvedValue(kind === 'missing' ? null : image)
  if (kind === 'lookup') find.mockRejectedValueOnce(new Error('signed URL'))
  await createMemeSearchHandler(find)(message as unknown as Message)
  expect(message.delete).not.toHaveBeenCalled()
})
it.each(['bot', 'webhook', 'dm', 'wrong-role', 'disabled', 'attachment', 'permissions', 'long'])(
  'ignores unsafe/ineligible %s input',
  async (kind) => {
    const { message } = fixture()
    if (kind === 'bot') message.author.bot = true
    if (kind === 'webhook') Object.assign(message, { webhookId: 'hook' })
    if (kind === 'dm') message.guildId = ''
    if (kind === 'wrong-role') message.content = '<@&999999999999999999> query'
    if (kind === 'disabled')
      manageCommunitySettings({ action: 'update', settings: { memeSearch: null } })
    if (kind === 'attachment') message.attachments.set('file', {})
    if (kind === 'permissions') message.deletable = false
    if (kind === 'long') message.content = `<@&${ROLE}> ${'x'.repeat(201)}`
    const find = vi.fn()
    await createMemeSearchHandler(find)(message as unknown as Message)
    expect(find).not.toHaveBeenCalled()
    expect(message.delete).not.toHaveBeenCalled()
  }
)
it('routes meme mentions before archive search or random role chat', async () => {
  const { message } = fixture()
  const commands = vi.fn().mockResolvedValue(false)
  const chat = vi.fn()
  const search = vi.fn()
  const meme = createMemeSearchHandler(async () => null)
  await createMessageHandler(commands, chat, search, meme)(message as unknown as Message)
  expect(search).not.toHaveBeenCalled()
  expect(chat).not.toHaveBeenCalled()
})

it('does not look up memes without webhook permission', async () => {
  const { message, channel } = fixture()
  channel.permissionsFor = () => ({ has: () => false })
  const find = vi.fn()
  await createMemeSearchHandler(find)(message as unknown as Message)
  expect(find).not.toHaveBeenCalled()
})

it('deduplicates concurrent deliveries within a channel', async () => {
  const { message, send } = fixture()
  let release!: (value: string) => void
  const find = vi.fn(
    () =>
      new Promise<string>((resolve) => {
        release = resolve
      })
  )
  const handle = createMemeSearchHandler(find)
  const first = handle(message as unknown as Message)
  expect(await handle(message as unknown as Message)).toBe(true)
  release(image)
  await first
  expect(find).toHaveBeenCalledOnce()
  expect(send).toHaveBeenCalledOnce()
})

it('does not reuse someone else’s webhook', async () => {
  const { message, channel } = fixture()
  const hooks = await channel.fetchWebhooks()
  hooks.first()!.owner.id = 'someone-else'
  await createMemeSearchHandler(async () => image)(message as unknown as Message)
  expect(channel.createWebhook).toHaveBeenCalledOnce()
})

it('rejects image URLs exceeding the Discord content limit', async () => {
  fetchMock
    .mockResolvedValueOnce(Response.json({ items: [{ id: ID, content_type: 'image' }] }))
    .mockResolvedValueOnce(
      Response.json({ original: { url: `https://s3.lth.so/${'x'.repeat(2000)}` } })
    )
  await expect(findMemeContent('query')).rejects.toThrow()
})
