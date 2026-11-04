import { join } from 'node:path'
import { MessageFlags, type Message } from 'discord.js'
import { beforeEach, afterEach, expect, it, vi } from 'vitest'
import { createArchiveSearchHandler } from '../archive-search.js'
import { generateArchiveSearchReply, renderArchiveSearchReply } from '../archive-search-ai.js'
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
  return {
    status: 'completed',
    output: [],
    output_text: JSON.stringify({ title: '검색 결과', summary: answer, results: [], warnings: [] })
  }
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

it('passes SQL results as JSON to the AI, parses its final JSON and renders the answer in Discord', async () => {
  const url = `https://discord.com/channels/${context.guildId}/${context.channelId}/1000000000000000100`
  const queryResult = {
    messages: [
      {
        id: '1000000000000000100',
        authorId: context.userId,
        authorName: 'member',
        createdAt: '2026-01-01T00:00:00Z',
        content: '피자 먹자',
        url
      }
    ],
    historyComplete: false,
    more: false,
    pendingEvents: 0,
    note: 'untrusted'
  }
  vi.mocked(searchDiscordHistory).mockResolvedValueOnce(queryResult)
  const finalJson = {
    title: '검색 결과',
    summary: '피자 관련 메시지 1개',
    results: [{ summary: '피자 먹자', url }],
    warnings: ['과거 기록 수집 미완료']
  }
  const markdown = `**검색 결과**\n피자 관련 메시지 1개\n\n- [원문](${url}) — 피자 먹자\n-# 과거 기록 수집 미완료`
  createResponse.mockResolvedValueOnce(tool()).mockResolvedValueOnce({
    status: 'completed',
    output: [],
    output_text: JSON.stringify(finalJson)
  })
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
  expect(createResponse.mock.calls[0]![0].instructions).toContain(
    'the server converts this JSON into Discord Markdown'
  )
  expect(createResponse.mock.calls[0]![0].instructions).toContain('no greetings, small talk')
  expect(createResponse.mock.calls[1]![0].input).toContainEqual(
    expect.objectContaining({
      type: 'function_call_output',
      call_id: 'call',
      output: JSON.stringify(queryResult)
    })
  )
  expect(createResponse.mock.calls[1]![0].input).toContainEqual(
    expect.objectContaining({ type: 'reasoning', encrypted_content: 'encrypted' })
  )
  expect(input.reply).toHaveBeenCalledWith({
    content: markdown,
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
it('passes count JSON back to the AI and renders its count summary with mandatory archive warnings', async () => {
  const sql = "SELECT COUNT(*) FROM messages WHERE content ILIKE '%피자%'"
  const count = {
    messages: [],
    aggregate: {
      operation: 'count' as const,
      target: 'messages' as const,
      value: '123',
      basis: 'archive' as const
    },
    historyComplete: false,
    more: false,
    pendingEvents: 2,
    note: 'Archive-based, not live-verified.'
  }
  vi.mocked(searchDiscordHistory).mockResolvedValueOnce(count)
  createResponse
    .mockResolvedValueOnce(tool(JSON.stringify({ sql })))
    .mockResolvedValueOnce(answer('피자를 언급한 메시지는 123개입니다.'))
  const input = message(`<@&${ROLE}> 피자 언급 메시지 몇 개야`)
  await createArchiveSearchHandler()(input)
  expect(searchDiscordHistory).toHaveBeenCalledWith(context, { sql }, expect.any(AbortSignal))
  expect(createResponse.mock.calls[1]![0].input).toContainEqual({
    type: 'function_call_output',
    call_id: 'call',
    output: JSON.stringify(count)
  })
  const reply = vi.mocked(input.reply).mock.calls[0]![0] as { content: string }
  expect(reply.content).toContain('123개')
  expect(reply.content).toContain('저장된 아카이브 기준')
  expect(reply.content).toContain('과거 기록 수집이 완료되지 않아')
  expect(reply.content).toContain('실시간 반영을 기다리는')
  expect(reply.content).not.toContain('[원문]')
  expect(reply.content).not.toContain('```json')
})
it('returns malformed arguments to the model without running SQL', async () => {
  createResponse.mockResolvedValueOnce(tool('not json')).mockResolvedValueOnce(answer('검색 오류'))
  await generateArchiveSearchReply('찾아줘', context)
  expect(searchDiscordHistory).not.toHaveBeenCalled()
  expect(createResponse.mock.calls[1]![0].input).toContainEqual(
    expect.objectContaining({ output: expect.stringContaining('Invalid history query') })
  )
})
it('rejects unknown tools, unsearched answers, incomplete responses and invalid JSON answers', async () => {
  for (const responses of [
    [tool('{}', 'shell')],
    [answer()],
    [{ status: 'incomplete', output: [] }],
    [tool(), answer('   ')],
    [tool(), answer('한'.repeat(401))],
    [tool(), { status: 'completed', output: [], output_text: 'not JSON' }],
    [tool(), { status: 'completed', output: [], output_text: '{"unexpected":"value"}' }]
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
it('renders JSON fields as Markdown without exposing JSON keys or code-block wrapping', async () => {
  createResponse
    .mockResolvedValueOnce(tool())
    .mockResolvedValueOnce(answer('피자 먹자는 메시지를 찾았습니다.'))
  const result = await generateArchiveSearchReply('찾아줘', context)
  expect(result.length).toBeLessThanOrEqual(2000)
  expect(result).toBe('**검색 결과**\n피자 먹자는 메시지를 찾았습니다.')
  expect(result).not.toContain('```')
  expect(result).not.toContain('"summary"')
})
it('rejects invented source URLs and bounds rendered output without cutting source links', () => {
  const url = `https://discord.com/channels/${context.guildId}/${context.channelId}/1000000000000000100`
  const data = {
    title: '*'.repeat(80),
    summary: '*'.repeat(400),
    results: Array.from({ length: 5 }, () => ({ summary: '*'.repeat(160), url })),
    warnings: ['*'.repeat(160), '*'.repeat(160), '*'.repeat(160)]
  }
  expect(() => renderArchiveSearchReply(data, new Set())).toThrow('Unverified')
  const result = renderArchiveSearchReply(data, new Set([url]))
  expect(result.length).toBeLessThanOrEqual(2000)
  expect(result).toContain('표시 길이 제한')
  expect(result).toContain('-# ')
})
it.each([`<@&${ROLE}>`, `<&@${ROLE}>`])(
  'routes %s before role chat without requiring role possession',
  async (mention) => {
    const generate = vi.fn().mockResolvedValue('**검색 결과**\n결과')
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
it('allows another search while one is pending and isolates failures without exposing details', async () => {
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
  expect(generate).toHaveBeenCalledTimes(2)
  expect(second.reply).toHaveBeenCalledWith(expect.objectContaining({ content: 'result' }))
  reject(new Error('secret-token'))
  await pending
  expect(JSON.stringify(vi.mocked(input.reply).mock.calls)).not.toContain('secret-token')
  await handler(message())
  expect(generate).toHaveBeenCalledTimes(3)
})
