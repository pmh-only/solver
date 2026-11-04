import { join } from 'node:path'
import { MessageFlags, type Message } from 'discord.js'
import { beforeEach, afterEach, expect, it, vi } from 'vitest'
import { createArchiveSearchHandler } from '../archive-search.js'
import { generateArchiveSearchReply } from '../archive-search-ai.js'
import { searchDiscordHistory } from '../discord-archive.js'
import { createMessageHandler } from '../message-handler.js'
import { manageCommunitySettings } from '../community-settings.js'
import { clearStoredValues } from '../helpers/kv-store.js'
import { isolateStoredValues } from '../helpers/kv-store-test.js'

const { createResponse } = vi.hoisted(() => ({ createResponse: vi.fn() }))
vi.mock('openai', () => ({
  default: class {
    responses = { create: createResponse }
  }
}))
vi.mock('../openai-config.js', () => ({
  loadOpenAIApiKey: () => 'test',
  loadOpenAIEndpoint: () => 'https://example.com'
}))
vi.mock('../discord-archive.js', async (original) => ({
  ...(await original<typeof import('../discord-archive.js')>()),
  searchDiscordHistory: vi.fn()
}))
const ROLE = '444444444444444444'
const context = {
  guildId: '333333333333333333',
  channelId: '777777777777777777',
  userId: '555555555555555555',
  requestMessageId: '1000000000000000200'
}
function message(content = `<@&${ROLE}> 지난주 피자 얘기 찾아줘`) {
  return {
    id: context.requestMessageId,
    guildId: context.guildId,
    channelId: context.channelId,
    author: { id: context.userId, bot: false },
    content,
    channel: { sendTyping: vi.fn().mockResolvedValue(undefined) },
    reply: vi.fn().mockResolvedValue(undefined)
  } as unknown as Message
}
const sql = "SELECT message_id FROM messages WHERE content ILIKE '%피자%'"
function tool(arguments_ = JSON.stringify({ sql }), name = 'search_discord_history') {
  return {
    status: 'completed',
    output: [
      { type: 'reasoning', id: 'r', encrypted_content: 'encrypted', summary: [] },
      { type: 'function_call', name, arguments: arguments_, call_id: 'call' }
    ]
  }
}
function answer(answer = '확인된 결과가 없습니다.') {
  return { status: 'completed', output: [], output_text: JSON.stringify({ answer }) }
}
beforeEach(() => {
  isolateStoredValues(join(process.cwd(), '.tmp', 'archive-search.test.sqlite'))
  clearStoredValues()
  vi.resetAllMocks()
  manageCommunitySettings({
    action: 'update',
    settings: {
      discordArchive: {
        channelId: context.channelId,
        searchRoleId: ROLE,
        searchModel: 'search-model'
      }
    }
  })
  vi.mocked(searchDiscordHistory).mockResolvedValue({
    messages: [],
    historyComplete: false,
    more: false,
    pendingEvents: 0,
    note: 'untrusted'
  })
})
afterEach(() => {
  clearStoredValues()
  vi.restoreAllMocks()
})

it('uses AI SQL tools with verified results and displays AI JSON output', async () => {
  createResponse.mockResolvedValueOnce(tool()).mockResolvedValueOnce(answer())
  const input = message()
  await createArchiveSearchHandler()(input)
  expect(searchDiscordHistory).toHaveBeenCalledExactlyOnceWith(
    context,
    { sql },
    expect.any(AbortSignal)
  )
  expect(createResponse.mock.calls[0]![0]).toMatchObject({
    model: 'search-model',
    tool_choice: 'required',
    store: false,
    parallel_tool_calls: false,
    text: { format: { type: 'json_schema', strict: true } }
  })
  expect(createResponse.mock.calls[1]![0].input).toContainEqual(
    expect.objectContaining({
      type: 'function_call_output',
      call_id: 'call',
      output: expect.stringContaining('historyComplete')
    })
  )
  expect(createResponse.mock.calls[1]![0].input).toContainEqual(
    expect.objectContaining({ type: 'reasoning', encrypted_content: 'encrypted' })
  )
  expect(input.reply).toHaveBeenCalledWith({
    content: expect.stringContaining('```json'),
    allowedMentions: { parse: [], repliedUser: false },
    flags: MessageFlags.SuppressEmbeds
  })
})
it('bounds searches and forces a final response after two SQL calls', async () => {
  createResponse
    .mockResolvedValueOnce(tool())
    .mockResolvedValueOnce(tool())
    .mockResolvedValueOnce(answer())
  await generateArchiveSearchReply('찾아줘', context)
  expect(searchDiscordHistory).toHaveBeenCalledTimes(2)
  expect(createResponse.mock.calls[2]![0].tool_choice).toBe('none')
})
it('returns malformed arguments to the model without running SQL', async () => {
  createResponse.mockResolvedValueOnce(tool('not json')).mockResolvedValueOnce(answer('검색 오류'))
  await generateArchiveSearchReply('찾아줘', context)
  expect(searchDiscordHistory).not.toHaveBeenCalled()
  expect(createResponse.mock.calls[1]![0].input).toContainEqual(
    expect.objectContaining({ output: expect.stringContaining('Invalid history query') })
  )
})
it('rejects unknown tools, unsearched answers, incomplete responses and malformed JSON', async () => {
  for (const responses of [
    [tool('{}', 'shell')],
    [answer()],
    [{ status: 'incomplete', output: [] }],
    [tool(), { status: 'completed', output: [], output_text: 'not json' }]
  ]) {
    createResponse.mockReset()
    for (const response of responses) createResponse.mockResolvedValueOnce(response)
    await expect(generateArchiveSearchReply('찾아줘', context)).rejects.toThrow()
  }
})
it('fails closed outside the configured channel and after disablement', async () => {
  await expect(
    generateArchiveSearchReply('찾아줘', { ...context, channelId: ROLE })
  ).rejects.toThrow()
  manageCommunitySettings({
    action: 'update',
    settings: { discordArchive: { searchRoleId: null } }
  })
  await expect(generateArchiveSearchReply('찾아줘', context)).rejects.toThrow()
  expect(createResponse).not.toHaveBeenCalled()
})
it('rechecks role-search disablement before executing a model-generated SQL call', async () => {
  createResponse.mockImplementationOnce(async () => {
    manageCommunitySettings({
      action: 'update',
      settings: { discordArchive: { searchRoleId: null } }
    })
    return tool()
  })
  await expect(generateArchiveSearchReply('찾아줘', context)).rejects.toThrow('disabled')
  expect(searchDiscordHistory).not.toHaveBeenCalled()
})
it('keeps model text inside a valid bounded JSON code block', async () => {
  createResponse.mockResolvedValueOnce(tool()).mockResolvedValueOnce(answer('``` @everyone'))
  const result = await generateArchiveSearchReply('찾아줘', context)
  expect(result.length).toBeLessThanOrEqual(2000)
  expect(result.match(/```/g) ?? []).toHaveLength(2)
  expect(JSON.parse(result.slice(8, -4))).toEqual({ answer: '``` @everyone' })
})
it.each([`<@&${ROLE}>`, `<&@${ROLE}>`])(
  'routes %s before role chat without requiring role possession',
  async (mention) => {
    const generate = vi.fn().mockResolvedValue('```json\n{"answer":"결과"}\n```')
    const chat = vi.fn()
    const handler = createMessageHandler(
      vi.fn().mockResolvedValue(false),
      chat,
      createArchiveSearchHandler(generate)
    )
    await handler(message(`${mention} 피자 찾아줘`))
    expect(generate).toHaveBeenCalledWith('피자 찾아줘', context)
    expect(chat).not.toHaveBeenCalled()
    await handler(message('일반 대화'))
    expect(chat).toHaveBeenCalledOnce()
  }
)
it('claims invalid inputs without paid requests and rate limits repeated requests', async () => {
  const generate = vi.fn().mockResolvedValue('result')
  const handler = createArchiveSearchHandler(generate)
  const empty = message(`<@&${ROLE}>`)
  expect(await handler(empty)).toBe(true)
  expect(generate).not.toHaveBeenCalled()
  for (let i = 0; i < 8; i++) await handler(message())
  expect(generate).toHaveBeenCalledTimes(2)
})
it('releases concurrency after safe errors without exposing service details', async () => {
  let reject!: (error: Error) => void
  const generate = vi
    .fn()
    .mockReturnValueOnce(
      new Promise((_, no) => {
        reject = no
      })
    )
    .mockResolvedValue('result')
  const handler = createArchiveSearchHandler(generate)
  const input = message()
  const pending = handler(input)
  await vi.waitFor(() => expect(generate).toHaveBeenCalledOnce())
  const second = message()
  await handler(second)
  expect(second.reply).toHaveBeenCalledWith(
    expect.objectContaining({ content: expect.stringContaining('다른 검색') })
  )
  reject(new Error('secret-token'))
  await pending
  expect(JSON.stringify(vi.mocked(input.reply).mock.calls)).not.toContain('secret-token')
  await handler(message())
  expect(generate).toHaveBeenCalledTimes(2)
})
