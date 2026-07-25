import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { InteractionResponseType, MessageFlags } from 'discord.js'
import { agentCommand } from '../application-commands.js'
import { clearStoredValues, getStoredValue } from '../helpers/kv-store.js'
import {
  agentCommandJSON,
  autocompleteJSON,
  dispatch,
  getCallback,
  getEdit,
  makeSubcommands
} from './e2e.js'

const { agentMock, disconnectMock, mcpClientMock, modelMock, streamMock, toolMock, transportMock } =
  vi.hoisted(() => ({
    agentMock: vi.fn(),
    disconnectMock: vi.fn().mockResolvedValue(undefined),
    mcpClientMock: vi.fn(),
    modelMock: vi.fn(),
    streamMock: vi.fn(),
    toolMock: vi.fn((options) => options),
    transportMock: vi.fn()
  }))

vi.mock('@modelcontextprotocol/sdk/client/stdio.js', () => ({
  StdioClientTransport: class MockStdioClientTransport {
    constructor(options: unknown) {
      transportMock(options)
    }
  }
}))

vi.mock('@strands-agents/sdk/models/openai', () => ({
  OpenAIModel: class MockOpenAIModel {
    constructor(options: unknown) {
      modelMock(options)
    }
  }
}))

vi.mock('@strands-agents/sdk', () => ({
  tool: toolMock,
  McpClient: class MockMcpClient {
    disconnect = disconnectMock

    constructor(options: unknown) {
      mcpClientMock(options)
    }
  },
  Agent: class MockAgent {
    constructor(options: unknown) {
      agentMock(options)
    }

    async *stream(prompt: string, options: unknown) {
      streamMock(prompt, options)
      for (const text of ['hello', ' world']) {
        yield {
          type: 'modelStreamUpdateEvent',
          event: { type: 'modelContentBlockDeltaEvent', delta: { type: 'textDelta', text } }
        }
      }
      yield {
        type: 'agentResultEvent',
        result: {
          metrics: {
            latestAgentInvocation: {
              usage: { inputTokens: 1234, outputTokens: 56, totalTokens: 1290 }
            }
          }
        }
      }
    }
  }
}))

const subs = makeSubcommands()

beforeEach(() => {
  process.env.OPENAI_API_KEY = 'test-key'
  clearStoredValues()
})

afterEach(() => {
  delete process.env.OPENAI_API_KEY
  delete process.env.SPOTIFY_CLIENT_ID
  vi.clearAllMocks()
})

describe('/a', () => {
  it('is registered as a dedicated command with prompt and optional session options', () => {
    const command = agentCommand.toJSON()

    expect(command.name).toBe('a')
    expect(command.options?.map((option) => option.name)).toEqual([
      'prompt',
      'session',
      'model',
      'effort',
      'tokens'
    ])
    expect(command.options?.[0]).toMatchObject({ name: 'prompt', required: true })
    expect(command.options?.[1]).toMatchObject({ name: 'session', required: false })
    expect(command.options?.[2]).toMatchObject({ name: 'model', required: false })
    expect(command.options?.[3]).toMatchObject({ name: 'effort', required: false })
    expect(command.options?.[4]).toMatchObject({
      name: 'tokens',
      required: false,
      min_value: 256,
      max_value: 16384
    })
  })

  it('always responds publicly with the selected session in the footer', async () => {
    const calls = await dispatch(agentCommandJSON('explain recursion'), subs)
    const defer = getCallback(calls) as { type: number; data?: { flags?: number } }
    expect(defer.type).toBe(InteractionResponseType.DeferredChannelMessageWithSource)
    expect((defer.data?.flags ?? 0) & MessageFlags.Ephemeral).toBeFalsy()
    const edit = getEdit(calls)
    expect(edit).not.toBeNull()
    expect(JSON.stringify(calls)).toContain('hello world')
    expect(JSON.stringify(calls)).toContain('Session: default')
    expect(JSON.stringify(calls)).toContain('Tokens used: 1,234 in / 56 out / 1,290 total')
    expect(JSON.stringify(calls)).toContain(
      'Model: gpt-5.4 | Reasoning effort: medium | Token limit: 4,096'
    )
    expect(JSON.stringify(calls)).not.toContain('`/a explain recursion`')
    expect(modelMock).toHaveBeenCalledWith(
      expect.objectContaining({ api: 'responses', apiKey: 'test-key', modelId: 'gpt-5.4' })
    )
    expect(agentMock).toHaveBeenCalledWith(
      expect.objectContaining({
        tools: [expect.objectContaining({ name: 'spotify_authenticate' })]
      })
    )
    expect(streamMock).toHaveBeenCalledWith(
      'explain recursion',
      expect.objectContaining({ limits: { turns: 8, outputTokens: 4096 } })
    )
  })

  it('gives the agent Spotify MCP tools when Spotify is configured', async () => {
    process.env.SPOTIFY_CLIENT_ID = 'spotify-client-id'

    await dispatch(agentCommandJSON('play my discovery mix'), subs)

    expect(transportMock).toHaveBeenCalledWith({
      command: process.execPath,
      args: [expect.stringMatching(/node_modules\/spotify-mcp\/dist\/index\.js$/)],
      env: expect.objectContaining({ SPOTIFY_CLIENT_ID: 'spotify-client-id' })
    })
    expect(mcpClientMock).toHaveBeenCalledWith(
      expect.objectContaining({ applicationName: 'solver /a' })
    )
    expect(agentMock).toHaveBeenCalledWith(
      expect.objectContaining({ tools: [expect.anything(), expect.anything()] })
    )
    expect(disconnectMock).toHaveBeenCalledOnce()
  })

  it('persists model, reasoning effort, and token limit per session', async () => {
    const configured = await dispatch(
      agentCommandJSON('configure', {}, 'work', {
        model: 'gpt-5.4-mini',
        effort: 'high',
        tokens: 2048
      }),
      subs
    )
    const continued = await dispatch(agentCommandJSON('continue', {}, 'work'), subs)
    const otherSession = await dispatch(agentCommandJSON('separate', {}, 'other'), subs)

    expect(JSON.stringify(configured)).toContain(
      'Model: gpt-5.4-mini | Reasoning effort: high | Token limit: 2,048'
    )
    expect(JSON.stringify(continued)).toContain(
      'Model: gpt-5.4-mini | Reasoning effort: high | Token limit: 2,048'
    )
    expect(JSON.stringify(otherSession)).toContain(
      'Model: gpt-5.4 | Reasoning effort: medium | Token limit: 4,096'
    )
    expect(modelMock).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        modelId: 'gpt-5.4-mini',
        maxTokens: 2048,
        params: { reasoning: { effort: 'high' } }
      })
    )
  })

  it('retains full conversation history in the selected session', async () => {
    await dispatch(agentCommandJSON('first question'), subs)
    await dispatch(agentCommandJSON('second question'), subs)

    expect(agentMock).toHaveBeenLastCalledWith(
      expect.objectContaining({
        messages: [
          expect.objectContaining({ role: 'user', content: [{ text: 'first question' }] }),
          expect.objectContaining({ role: 'assistant', content: [{ text: 'hello world' }] })
        ]
      })
    )
  })

  it('switches to a new session and keeps it selected', async () => {
    await dispatch(agentCommandJSON('default question'), subs)
    const switched = await dispatch(agentCommandJSON('work question', {}, 'work'), subs)
    const continued = await dispatch(agentCommandJSON('follow-up'), subs)

    expect(JSON.stringify(switched)).toContain('Session: work')
    expect(JSON.stringify(continued)).toContain('Session: work')
    expect(agentMock).toHaveBeenLastCalledWith(
      expect.objectContaining({
        messages: [
          expect.objectContaining({ role: 'user', content: [{ text: 'work question' }] }),
          expect.objectContaining({ role: 'assistant', content: [{ text: 'hello world' }] })
        ]
      })
    )
  })

  it('serializes overlapping requests in the same session', async () => {
    await Promise.all([
      dispatch(agentCommandJSON('first concurrent question'), subs),
      dispatch(agentCommandJSON('second concurrent question'), subs)
    ])

    expect(agentMock).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        messages: [
          expect.objectContaining({
            role: 'user',
            content: [{ text: 'first concurrent question' }]
          }),
          expect.objectContaining({ role: 'assistant', content: [{ text: 'hello world' }] })
        ]
      })
    )
  })

  it('keeps multiline session names on one escaped footer line', async () => {
    const calls = await dispatch(agentCommandJSON('question', {}, 'work\n# notes'), subs)

    expect(JSON.stringify(calls)).toContain('Session: work # notes')
    expect(JSON.stringify(calls)).not.toContain('Session: work\\n# notes')
  })

  it('edits reply when no API key', async () => {
    delete process.env.OPENAI_API_KEY
    const calls = await dispatch(agentCommandJSON('what is 2+2'), subs)
    const defer = getCallback(calls) as { type: number }
    expect(defer.type).toBe(InteractionResponseType.DeferredChannelMessageWithSource)
    const edit = getEdit(calls) as { components?: unknown } | null
    expect(edit).not.toBeNull()
    expect(getStoredValue('gpt-session:666666666666666666:default')).toBe('[]')
  })

  it('is no longer exposed through /c autocomplete', async () => {
    const calls = await dispatch(autocompleteJSON('gp'), subs)
    const body = getCallback(calls) as {
      type: number
      data: { choices: { value: string }[] }
    }
    expect(body.type).toBe(InteractionResponseType.ApplicationCommandAutocompleteResult)
    expect(body.data.choices.some((c) => c.value === 'gpt')).toBeFalsy()
  })
})
