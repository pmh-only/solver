import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { InteractionResponseType, MessageFlags } from 'discord.js'
import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import { agentCommand } from '../application-commands.js'
import {
  GPT_ACTION_COMPONENT_ID,
  GPT_MODAL_ID,
  cancelWebAgent,
  createWebSession,
  loadWebConversation,
  loadWebSessionState,
  runWebAgent,
  runWebComponentInteraction,
  runWebInteraction
} from '../commands/gpt.js'
import {
  clearStoredValues,
  getStoredValue,
  resetStoredValueConnection,
  setStoredValue
} from '../helpers/kv-store.js'
import { clearModelCache } from '../model-catalog.js'
import { updateOpenAIToken } from '../openai-config.js'
import { updateSystemPrompt } from '../system-prompt.js'
import {
  agentCommandJSON,
  agentModelAutocompleteJSON,
  agentSessionAutocompleteJSON,
  autocompleteJSON,
  buttonJSON,
  dispatch,
  getCallback,
  getEdit,
  makeSubcommands,
  modalJSON,
  selectJSON
} from './e2e.js'

const {
  agentMock,
  disconnectMock,
  httpTransportMock,
  mcpActions,
  mcpActionResults,
  mcpClientMock,
  mcpToolFailures,
  mcpToolGroups,
  mcpToolNumber,
  modelMock,
  componentActions,
  modalActions,
  registeredAgentTools,
  responsePayloads,
  streamRelease,
  streamMock,
  toolMock,
  toolRegistryAddMock,
  toolRegistryRemoveMock,
  transportMock
} = vi.hoisted(() => {
  const registeredAgentTools = new Map<string, Record<string, unknown>>()
  return {
    agentMock: vi.fn(),
    disconnectMock: vi.fn().mockResolvedValue(undefined),
    httpTransportMock: vi.fn(),
    mcpActions: [] as Record<string, unknown>[],
    mcpActionResults: [] as unknown[],
    mcpClientMock: vi.fn(),
    mcpToolFailures: [] as boolean[],
    mcpToolGroups: [] as Record<string, unknown>[][],
    mcpToolNumber: { value: 0 },
    modelMock: vi.fn(),
    componentActions: [] as Record<string, unknown>[],
    modalActions: [] as Record<string, unknown>[],
    responsePayloads: [] as unknown[],
    streamRelease: { resolve: undefined as (() => void) | undefined },
    streamMock: vi.fn(),
    toolMock: vi.fn((options) => options),
    toolRegistryAddMock: vi.fn((tools: Record<string, unknown>[]) => {
      for (const candidate of tools) registeredAgentTools.set(String(candidate.name), candidate)
    }),
    toolRegistryRemoveMock: vi.fn((name: string) => registeredAgentTools.delete(name)),
    registeredAgentTools,
    transportMock: vi.fn()
  }
})

vi.mock('@modelcontextprotocol/sdk/client/stdio.js', () => ({
  StdioClientTransport: class MockStdioClientTransport {
    constructor(options: unknown) {
      transportMock(options)
    }
  }
}))

vi.mock('@modelcontextprotocol/sdk/client/streamableHttp.js', () => ({
  StreamableHTTPClientTransport: class MockStreamableHTTPClientTransport {
    constructor(url: URL, options: unknown) {
      httpTransportMock(url, options)
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
    listTools: () => Promise<Record<string, unknown>[]>

    constructor(options: unknown) {
      mcpClientMock(options)
      const tools = mcpToolGroups.shift() ?? [
        { name: `mcp_tool_${mcpToolNumber.value++}`, description: 'MCP tool' }
      ]
      this.listTools = vi
        .fn()
        .mockImplementation(() =>
          mcpToolFailures.shift()
            ? Promise.reject(new Error('MCP authentication failed'))
            : Promise.resolve(tools)
        )
    }
  },
  Agent: class MockAgent {
    private options: { tools?: { name?: string; callback?: (input: never) => unknown }[] }
    messages: Array<{
      role: 'user' | 'assistant'
      content: Record<string, unknown>[]
      toJSON: () => { role: 'user' | 'assistant'; content: Record<string, unknown>[] }
    }>
    toolRegistry: {
      get: (name: string) => Record<string, unknown> | undefined
      remove: (name: string) => void
      addOrReplace: (tools: Record<string, unknown>[]) => void
    }

    constructor(options: unknown) {
      agentMock(options)
      this.options = options as typeof this.options
      const initial = (options as { messages?: Array<{ role: 'user' | 'assistant'; content: [] }> })
        .messages
      this.messages = (initial ?? []).map((message) => this.message(message))
      for (const candidate of this.options.tools ?? []) {
        if (candidate.name) registeredAgentTools.set(candidate.name, candidate)
      }
      this.toolRegistry = {
        get: (name) => registeredAgentTools.get(name),
        remove: toolRegistryRemoveMock,
        addOrReplace: toolRegistryAddMock
      }
    }

    get tools() {
      return [...registeredAgentTools.values()]
    }

    private message(data: { role: 'user' | 'assistant'; content: Record<string, unknown>[] }) {
      const serialized = structuredClone(data)
      return { ...serialized, toJSON: () => structuredClone(serialized) }
    }

    async *stream(prompt: string, options: unknown) {
      this.messages.push(this.message({ role: 'user', content: [{ text: prompt }] }))
      const streamResult = streamMock(prompt, options)
      if (streamResult instanceof Error) throw streamResult
      if (streamResult === 'waitInTool') {
        const wait = this.options.tools?.find((candidate) => candidate.name === 'wait')
        await wait?.callback?.({ seconds: 600 } as never)
        return
      }
      if (streamResult === 'waitForAbort') {
        yield {
          type: 'modelStreamUpdateEvent',
          event: {
            type: 'modelContentBlockDeltaEvent',
            delta: { type: 'reasoningContentDelta', text: 'Working through the request.' }
          }
        }
        const signal = (options as { cancelSignal: AbortSignal }).cancelSignal
        await new Promise<void>((resolve) => {
          if (signal.aborted) resolve()
          else signal.addEventListener('abort', () => resolve(), { once: true })
        })
        this.messages.push(
          this.message({ role: 'assistant', content: [{ text: 'Cancelled by user' }] })
        )
        return
      }
      if (streamResult === 'waitForRelease') {
        yield {
          type: 'modelStreamUpdateEvent',
          event: {
            type: 'modelContentBlockDeltaEvent',
            delta: { type: 'reasoningContentDelta', text: 'Visible from the web UI.' }
          }
        }
        await new Promise<void>((resolve) => {
          streamRelease.resolve = resolve
        })
      }
      const componentAction = componentActions.shift()
      const modalAction = modalActions.shift()
      if (modalAction) {
        const modalTool = this.options.tools?.find(
          (candidate) => candidate.name === 'manage_response_modals'
        )
        modalTool?.callback?.(modalAction as never)
      }
      const mcpAction = mcpActions.shift()
      if (mcpAction) {
        const mcpTool = this.options.tools?.find(
          (candidate) => candidate.name === 'manage_mcp_servers'
        )
        mcpActionResults.push(await mcpTool?.callback?.(mcpAction as never))
      }
      yield {
        type: 'modelStreamUpdateEvent',
        event: { type: 'modelContentBlockStartEvent' }
      }
      yield {
        type: 'modelStreamUpdateEvent',
        event: {
          type: 'modelContentBlockDeltaEvent',
          delta: {
            type: 'reasoningContentDelta',
            text:
              streamResult === 'multipleActivity' ? 'Earlier reasoning.' : 'I should look this up.'
          }
        }
      }
      yield {
        type: 'modelStreamUpdateEvent',
        event: {
          type: 'modelContentBlockStartEvent',
          start: { type: 'toolUseStart', name: 'docker_list', toolUseId: 'tool-1' }
        }
      }
      yield {
        type: 'modelStreamUpdateEvent',
        event: {
          type: 'modelContentBlockDeltaEvent',
          delta: { type: 'toolUseInputDelta', input: '{"apiKey":"secret"}' }
        }
      }
      yield {
        type: 'toolResultEvent',
        result: { toolUseId: 'tool-1', status: 'success', content: [] }
      }
      this.messages.push(
        this.message({
          role: 'assistant',
          content: [
            { reasoning: { text: 'I should look this up.' } },
            {
              toolUse: {
                name: 'docker_list',
                toolUseId: 'tool-1',
                input: { apiKey: 'secret' }
              }
            }
          ]
        }),
        this.message({
          role: 'user',
          content: [
            {
              toolResult: {
                toolUseId: 'tool-1',
                status: 'success',
                content: [{ text: 'container is running' }]
              }
            }
          ]
        })
      )
      yield {
        type: 'modelStreamUpdateEvent',
        event: {
          type: 'modelContentBlockDeltaEvent',
          delta: {
            type: 'citationsDelta',
            citations: [{ source: 'https://example.com' }],
            content: []
          }
        }
      }
      if (streamResult === 'throwAfterActivity') {
        throw new Error('unable to parse tool input JSON')
      }
      if (streamResult === 'multipleActivity') {
        yield {
          type: 'modelStreamUpdateEvent',
          event: { type: 'modelContentBlockStartEvent' }
        }
        yield {
          type: 'modelStreamUpdateEvent',
          event: {
            type: 'modelContentBlockDeltaEvent',
            delta: { type: 'reasoningContentDelta', text: 'Latest reasoning.' }
          }
        }
        for (let index = 0; index < 3; index++) {
          yield {
            type: 'modelStreamUpdateEvent',
            event: {
              type: 'modelContentBlockStartEvent',
              start: { type: 'toolUseStart', name: 'search', toolUseId: `search-${index}` }
            }
          }
          yield {
            type: 'toolResultEvent',
            result: { toolUseId: `search-${index}`, status: 'success', content: [] }
          }
        }
      }
      if (streamResult !== 'noResponse') {
        const responsePayload = responsePayloads.shift()
        const response =
          typeof responsePayload === 'string'
            ? responsePayload
            : JSON.stringify(
                responsePayload ?? {
                  content: 'hello world',
                  ...(typeof componentAction?.components_json === 'string'
                    ? { components: JSON.parse(componentAction.components_json) }
                    : {})
                }
              )
        yield {
          type: 'modelStreamUpdateEvent',
          event: { type: 'modelContentBlockStartEvent' }
        }
        for (const text of [response.slice(0, 10), response.slice(10)]) {
          yield {
            type: 'modelStreamUpdateEvent',
            event: { type: 'modelContentBlockDeltaEvent', delta: { type: 'textDelta', text } }
          }
        }
        this.messages.push(this.message({ role: 'assistant', content: [{ text: response }] }))
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
const googleCalendarTestDirectory = join(process.cwd(), '.tmp', 'gpt-google-calendar-test')
const previousKvStorePath = process.env.KV_STORE_PATH

function expectStoredAgentHistory(callIndex: number, prompt: string): void {
  const options = agentMock.mock.calls.at(callIndex)?.[0] as { messages?: unknown[] }
  expect(options.messages).toEqual([
    { role: 'user', content: [{ text: prompt }] },
    {
      role: 'assistant',
      content: [
        { reasoning: { text: 'I should look this up.' } },
        expect.objectContaining({ toolUse: expect.objectContaining({ name: 'docker_list' }) })
      ]
    },
    {
      role: 'user',
      content: [
        expect.objectContaining({
          toolResult: expect.objectContaining({
            status: 'success',
            content: [{ text: 'container is running' }]
          })
        })
      ]
    },
    { role: 'assistant', content: [{ text: '{"content":"hello world"}' }] }
  ])
}

beforeEach(() => {
  process.env.OPENAI_API_KEY = 'test-key'
  componentActions.length = 0
  modalActions.length = 0
  mcpActions.length = 0
  mcpActionResults.length = 0
  mcpToolFailures.length = 0
  registeredAgentTools.clear()
  responsePayloads.length = 0
  streamRelease.resolve = undefined
  mcpToolGroups.length = 0
  mcpToolNumber.value = 0
  clearModelCache()
  clearStoredValues()
})

afterEach(async () => {
  delete process.env.OPENAI_API_KEY
  delete process.env.MAIL_API_KEY
  delete process.env.GOOGLE_OAUTH_CREDENTIALS_BASE64
  delete process.env.GOOGLE_CALENDAR_REDIRECT_URI
  delete process.env.SPOTIFY_CLIENT_ID
  delete process.env.WEB_DOMAIN
  if (previousKvStorePath === undefined) delete process.env.KV_STORE_PATH
  else process.env.KV_STORE_PATH = previousKvStorePath
  await rm(googleCalendarTestDirectory, { recursive: true, force: true })
  vi.restoreAllMocks()
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
      'tokens',
      'system_prompt',
      'reset_system_prompt',
      'openai_endpoint',
      'reset_openai_endpoint'
    ])
    expect(command.options?.[0]).toMatchObject({ name: 'prompt', required: true })
    expect(command.options?.[1]).toMatchObject({
      name: 'session',
      required: false,
      autocomplete: true
    })
    expect(command.options?.[2]).toMatchObject({
      name: 'model',
      required: false,
      autocomplete: true
    })
    expect(command.options?.[3]).toMatchObject({ name: 'effort', required: false })
    expect(command.options?.[4]).toMatchObject({
      name: 'tokens',
      required: false,
      min_value: 256,
      max_value: 16384
    })
  })

  it('suggests known models without requiring the submitted value to match', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          data: [{ id: 'dynamic-large' }, { id: 'dynamic-mini' }, { id: 'unrelated-model' }]
        }),
        { status: 200 }
      )
    )
    const calls = await dispatch(agentModelAutocompleteJSON('mini'), subs)
    const body = getCallback(calls) as {
      type: number
      data: { choices: Array<{ name: string; value: string }> }
    }

    expect(body.type).toBe(InteractionResponseType.ApplicationCommandAutocompleteResult)
    expect(body.data.choices).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: 'dynamic-mini', value: 'dynamic-mini' })
      ])
    )
    expect(body.data.choices).not.toContainEqual(
      expect.objectContaining({ value: 'vendor/custom-model-preview' })
    )
  })

  it('returns no suggestions when dynamic model discovery is unavailable', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('', { status: 503 }))
    vi.spyOn(console, 'error').mockImplementation(() => {})

    const calls = await dispatch(agentModelAutocompleteJSON('custom'), subs)
    const body = getCallback(calls) as { data: { choices: unknown[] } }

    expect(body.data.choices).toEqual([])
  })

  it('renders the agent JSON publicly and appends token usage', async () => {
    const calls = await dispatch(agentCommandJSON('explain recursion'), subs)
    const defer = getCallback(calls) as { type: number; data?: { flags?: number } }
    expect(defer.type).toBe(InteractionResponseType.DeferredChannelMessageWithSource)
    expect((defer.data?.flags ?? 0) & MessageFlags.Ephemeral).toBeFalsy()
    const edit = getEdit(calls) as {
      components: Array<{ type: number; content?: string; divider?: boolean }>
      flags: number
    }
    expect(edit.flags & MessageFlags.IsComponentsV2).toBeTruthy()
    expect(edit.components.slice(0, 2)).toEqual([
      { type: 10, content: '**explain recursion**' },
      { type: 14, divider: true, spacing: 1 }
    ])
    expect(JSON.stringify(calls)).toContain('hello world')
    expect(JSON.stringify(calls)).toContain('**Reasoning**')
    expect(JSON.stringify(calls)).toContain('I should look this up.')
    expect(JSON.stringify(calls)).toContain('**Tools used**')
    expect(JSON.stringify(calls)).toContain('`docker_list`: success')
    expect(JSON.stringify(calls)).toContain('`web_search`: success')
    expect(JSON.stringify(calls)).not.toContain('apiKey')
    expect(JSON.stringify(calls)).not.toContain('secret')
    expect(JSON.stringify(calls)).toContain('Tokens used: 1,234 in / 56 out / 1,290 total')
    expect(JSON.stringify(calls)).toContain(
      'Model: gpt-5.4 | Reasoning effort: medium | Token limit: 4,096'
    )
    expect(JSON.stringify(calls)).not.toContain('`/a explain recursion`')
    expect(modelMock).toHaveBeenCalledWith(
      expect.objectContaining({
        api: 'responses',
        apiKey: 'test-key',
        clientConfig: { baseURL: 'https://api.openai.com/v1' },
        modelId: 'gpt-5.4',
        params: {
          reasoning: { effort: 'medium', summary: 'auto' },
          tools: [{ type: 'web_search' }]
        }
      })
    )
    expect(transportMock).toHaveBeenCalledWith({ command: 'uvx', args: ['mcp-server-docker'] })
    expect(transportMock).toHaveBeenCalledWith({
      command: 'uvx',
      args: ['--with', 'mcp==1.29.0', 'mcp-server-fetch==2026.7.10']
    })
    expect(transportMock).toHaveBeenCalledWith({
      command: 'uvx',
      args: ['--with', 'mcp==1.29.0', 'mcp-server-time==2026.7.10']
    })
    expect(transportMock).toHaveBeenCalledWith({
      command: process.execPath,
      args: [
        expect.stringMatching(/server-filesystem\/dist\/index\.js$/),
        '/'
      ]
    })
    expect(transportMock).toHaveBeenCalledWith({
      command: process.execPath,
      args: [expect.stringMatching(/server-memory\/dist\/index\.js$/)],
      env: { MEMORY_FILE_PATH: expect.stringMatching(/data\/\.agent-memory\.jsonl$/) }
    })
    expect(transportMock).toHaveBeenCalledWith({
      command: process.execPath,
      args: [expect.stringMatching(/server-sequential-thinking\/dist\/index\.js$/)]
    })
    expect(transportMock).toHaveBeenCalledWith({
      command: process.execPath,
      args: [
        expect.stringMatching(/@playwright\/mcp\/cli\.js$/),
        '--headless',
        '--isolated',
        '--no-sandbox',
        '--image-responses',
        'omit',
        '--executable-path',
        '/usr/bin/chromium'
      ]
    })
    expect(mcpClientMock).toHaveBeenCalledWith(
      expect.objectContaining({ applicationName: 'solver /a Docker' })
    )
    expect(agentMock).toHaveBeenCalledWith(
      expect.objectContaining({
        tools: [
          expect.objectContaining({ name: 'shell' }),
          expect.objectContaining({ name: 'wait' }),
          expect.objectContaining({ name: 'publish_html' }),
          expect.objectContaining({ name: 'spotify_authenticate' }),
          expect.objectContaining({ name: 'google_calendar_authenticate' }),
          expect.objectContaining({ name: 'manage_mcp_servers' }),
          expect.objectContaining({ name: 'manage_response_modals' }),
          ...Array(7).fill(expect.anything())
        ]
      })
    )
    expect(disconnectMock).toHaveBeenCalledTimes(7)
    expect(streamMock).toHaveBeenCalledWith(
      'explain recursion',
      expect.objectContaining({ cancelSignal: expect.any(AbortSignal) })
    )
    expect(streamMock.mock.calls[0]?.[1]).not.toHaveProperty('limits')
    const finalEdit = calls.filter((call) => call.method === 'PATCH').at(-1)?.body as {
      components: Array<{ type: number; content?: string; divider?: boolean }>
    }
    expect(finalEdit.components.slice(0, 2)).toEqual([
      { type: 10, content: '**explain recursion**' },
      { type: 14, divider: true, spacing: 1 }
    ])
  })

  it('provides a bounded wait tool', async () => {
    await dispatch(agentCommandJSON('wait briefly'), subs)
    const wait = registeredAgentTools.get('wait') as {
      callback: (input: { seconds: number }) => Promise<string>
    }

    await expect(wait.callback({ seconds: 0.1 })).resolves.toBe('Waited 0.1 seconds.')
  })

  it('updates reasoning and tool status while the agent is generating', async () => {
    const calls = await dispatch(agentCommandJSON('inspect the system'), subs)
    const progressEdits = calls
      .filter((call) => call.method === 'PATCH')
      .slice(0, -1)
      .map((call) => JSON.stringify(call.body))

    expect(progressEdits.some((edit) => edit.includes('I should look this up.'))).toBe(true)
    expect(progressEdits.some((edit) => edit.includes('`docker_list`: running'))).toBe(true)
    expect(progressEdits.some((edit) => edit.includes('`docker_list`: success'))).toBe(true)
    expect(progressEdits.every((edit) => edit.includes('generating...'))).toBe(true)
    expect(progressEdits.every((edit) => edit.includes('**inspect the system**'))).toBe(true)
    expect(progressEdits.every((edit) => edit.includes('"type":14'))).toBe(true)
    expect(progressEdits.every((edit) => edit.includes('"flags":32768'))).toBe(true)
    expect(progressEdits.every((edit) => !edit.includes('secret'))).toBe(true)
  })

  it('shows only the latest reasoning, every tool use, then compact tool counts', async () => {
    streamMock.mockReturnValueOnce('multipleActivity')

    const calls = await dispatch(agentCommandJSON('research this'), subs)
    const progressEdits = calls
      .filter((call) => call.method === 'PATCH')
      .slice(0, -1)
      .map((call) => JSON.stringify(call.body))
    const latestReasoningEdit = [...progressEdits]
      .reverse()
      .find((edit) => edit.includes('Latest reasoning.') && edit.includes('`search`: success'))!
    const compactEdit = progressEdits.find((edit) => edit.includes('search x3'))!

    expect(latestReasoningEdit).not.toContain('Earlier reasoning.')
    expect(latestReasoningEdit).toContain('`docker_list`: success')
    expect(latestReasoningEdit).toContain('`web_search`: success')
    expect(latestReasoningEdit.match(/`search`: success/g)).toHaveLength(3)
    expect(compactEdit).toContain('(docker_list x1, web_search x1, search x3)')
    expect(compactEdit).not.toContain('**Reasoning**')
    expect(compactEdit).not.toContain('Latest reasoning.')
  })

  it('renders a valid fallback when the agent emits no response text', async () => {
    streamMock.mockReturnValueOnce('noResponse')

    const calls = await dispatch(agentCommandJSON('do the work'), subs)
    const finalEdit = calls.filter((call) => call.method === 'PATCH').at(-1)?.body

    expect(JSON.stringify(finalEdit)).toContain('(no response)')
    expect(JSON.stringify(finalEdit)).not.toContain('Unexpected token')
    expect(getStoredValue('gpt-session:default')).toContain('{\\"content\\":\\"(no response)\\"}')
  })

  it('retries malformed tool input JSON with stricter tool guidance', async () => {
    streamMock.mockReturnValueOnce(new Error('unable to parse tool input JSON'))

    const calls = await dispatch(agentCommandJSON('inspect the system'), subs)

    expect(agentMock).toHaveBeenCalledTimes(1)
    expect(streamMock).toHaveBeenNthCalledWith(
      2,
      expect.stringContaining('Ensure every tool input is one complete valid JSON object'),
      expect.anything()
    )
    expect(JSON.stringify(calls)).toContain('hello world')
    expect(JSON.stringify(calls)).not.toContain('error: unable to parse tool input JSON')
  })

  it('continues from the current agent state after a general tool-use error', async () => {
    streamMock.mockReturnValueOnce(new Error('tool execution failed'))

    const calls = await dispatch(agentCommandJSON('inspect the system'), subs)

    expect(agentMock).toHaveBeenCalledTimes(1)
    expect(streamMock).toHaveBeenNthCalledWith(
      2,
      expect.stringContaining('Continue from the current state'),
      expect.anything()
    )
    expect(JSON.stringify(calls)).toContain('hello world')
    expect(JSON.stringify(calls)).not.toContain('error: tool execution failed')
  })

  it('has the current agent repair malformed response JSON', async () => {
    responsePayloads.push('not valid JSON', { content: 'repaired response' })

    const calls = await dispatch(agentCommandJSON('show status'), subs)

    expect(agentMock).toHaveBeenCalledTimes(1)
    expect(streamMock).toHaveBeenNthCalledWith(
      2,
      expect.stringContaining('Unexpected token'),
      expect.anything()
    )
    expect(JSON.stringify(calls)).toContain('repaired response')
    expect(JSON.stringify(calls)).not.toContain('error: Unexpected token')
  })

  it('retains reasoning and failed tool status if malformed tool input persists', async () => {
    streamMock.mockReturnValueOnce('throwAfterActivity').mockReturnValueOnce('throwAfterActivity')

    const calls = await dispatch(agentCommandJSON('inspect the system'), subs)
    const finalEdit = calls.filter((call) => call.method === 'PATCH').at(-1)?.body
    const rendered = JSON.stringify(finalEdit)

    expect(agentMock).toHaveBeenCalledTimes(1)
    expect(rendered).toContain('error: unable to parse tool input JSON')
    expect(rendered).toContain('I should look this up.')
    expect(rendered).toContain('`docker_list`: error')
    expect(rendered).not.toContain('secret')
  })

  it('provides the configured web domain and publishing tool to the agent', async () => {
    process.env.WEB_DOMAIN = 'https://pages.example.com'

    await dispatch(agentCommandJSON('build a landing page'), subs)

    expect(agentMock).toHaveBeenCalledWith(
      expect.objectContaining({
        systemPrompt: expect.stringContaining(
          'persistent single-file web page at a new unique URL under the configured web domain'
        ),
        tools: expect.arrayContaining([expect.objectContaining({ name: 'publish_html' })])
      })
    )
  })

  it('loads the persistent global system prompt for each request', async () => {
    updateSystemPrompt({ prompt: 'Always explain the key tradeoff.' }, 'admin')

    await dispatch(agentCommandJSON('design this'), subs)
    await dispatch(agentCommandJSON('design that', {}, 'another session'), subs)

    expect(agentMock.mock.calls[0]?.[0].systemPrompt).toContain('Always explain the key tradeoff.')
    expect(agentMock.mock.calls[1]?.[0].systemPrompt).toContain('Always explain the key tradeoff.')
  })

  it('persists and resets a system prompt for only the selected session', async () => {
    await dispatch(
      agentCommandJSON('configure this session', {}, 'work', {
        systemPrompt: 'Use terse release-management language.'
      }),
      subs
    )
    await dispatch(agentCommandJSON('continue', {}, 'work'), subs)
    await dispatch(agentCommandJSON('other session', {}, 'other'), subs)

    expect(agentMock.mock.calls[0]?.[0]).toMatchObject({
      systemPrompt: expect.stringContaining('Use terse release-management language.')
    })
    expect(agentMock.mock.calls[1]?.[0]).toMatchObject({
      systemPrompt: expect.stringContaining('Use terse release-management language.')
    })
    expect(agentMock.mock.calls[2]?.[0].systemPrompt).not.toContain(
      'Use terse release-management language.'
    )

    await dispatch(
      agentCommandJSON('reset this session', {}, 'work', { resetSystemPrompt: true }),
      subs
    )
    expect(agentMock.mock.calls[3]?.[0].systemPrompt).not.toContain(
      'Use terse release-management language.'
    )
  })

  it('persists one OpenAI endpoint across sessions and can restore the default', async () => {
    await dispatch(
      agentCommandJSON('use the proxy', {}, 'work', {
        openAIEndpoint: 'https://inference.example.com/openai/v1/'
      }),
      subs
    )
    await dispatch(agentCommandJSON('continue elsewhere', {}, 'other'), subs)

    expect(modelMock.mock.calls[0]?.[0]).toMatchObject({
      clientConfig: { baseURL: 'https://inference.example.com/openai/v1' }
    })
    expect(modelMock.mock.calls[1]?.[0]).toMatchObject({
      clientConfig: { baseURL: 'https://inference.example.com/openai/v1' }
    })

    await dispatch(
      agentCommandJSON('restore OpenAI', {}, 'work', { resetOpenAIEndpoint: true }),
      subs
    )
    expect(modelMock.mock.calls[2]?.[0]).toMatchObject({
      clientConfig: { baseURL: 'https://api.openai.com/v1' }
    })
  })

  it('uses the encrypted OpenAI token override without exposing it in replies', async () => {
    updateOpenAIToken({ token: 'override-secret-token' }, 'admin')

    const calls = await dispatch(agentCommandJSON('use configured credentials'), subs)

    expect(modelMock).toHaveBeenCalledWith(
      expect.objectContaining({ apiKey: 'override-secret-token' })
    )
    expect(JSON.stringify(calls)).not.toContain('override-secret-token')
  })

  it('preserves raw Discord embeds and appends token usage to the last footer', async () => {
    responsePayloads.push({
      embeds: [{ title: 'Status', description: 'Everything is healthy', footer: { text: 'Live' } }],
      allowed_mentions: { parse: [] }
    })

    const calls = await dispatch(agentCommandJSON('show status'), subs)
    const edit = calls.filter((call) => call.method === 'PATCH').at(-1)?.body as {
      content?: string
      embeds: Array<{ footer?: { text?: string } }>
      components: unknown[]
      allowed_mentions?: unknown
    }

    expect(edit.embeds[0]?.footer?.text).toContain('Live\nTokens used:')
    expect(edit.components).toEqual([])
    expect(edit.allowed_mentions).toEqual({ parse: [] })
    expect(JSON.stringify(edit.content)).toContain('**show status**')
    expect(JSON.stringify(edit.content)).toContain('-# --------------------------------')
    expect(JSON.stringify(edit.content)).toContain('(docker_list x1, web_search x1)')
    expect(JSON.stringify(edit.content)).not.toContain('**Reasoning**')
  })

  it('renders content inside Components V2 after the request prompt and a divider', async () => {
    responsePayloads.push({
      content: 'Rendered response',
      components: [{ type: 10, content: 'Additional context' }],
      flags: MessageFlags.IsComponentsV2
    })

    const calls = await dispatch(agentCommandJSON('show the request'), subs)
    const edit = calls.filter((call) => call.method === 'PATCH').at(-1)?.body as {
      content: string | null
      components: Array<{ type: number; content?: string; divider?: boolean }>
      flags: number
    }

    expect(edit.flags & MessageFlags.IsComponentsV2).toBeTruthy()
    expect(edit.content).toBe('')
    expect(edit.components.slice(0, 4)).toEqual([
      { type: 10, content: '**show the request**' },
      { type: 14, divider: true, spacing: 1 },
      { type: 10, content: 'Rendered response' },
      { type: 10, content: 'Additional context' }
    ])
    expect(edit.components.at(-1)?.content).toContain('Tokens used:')
    expect(edit.components.at(-2)?.content).toContain('(docker_list x1, web_search x1)')
    expect(edit.components.at(-2)?.content).not.toContain('**Reasoning**')
  })

  it('accepts raw Discord API poll JSON', async () => {
    responsePayloads.push({
      content: 'Vote now',
      poll: {
        question: { text: 'Preferred release day?' },
        answers: [{ poll_media: { text: 'Tuesday' } }, { poll_media: { text: 'Thursday' } }],
        duration: 24,
        allow_multiselect: true
      }
    })

    const calls = await dispatch(agentCommandJSON('create a release poll'), subs)
    const edit = calls.filter((call) => call.method === 'PATCH').at(-1)?.body as {
      poll?: { answers?: Array<{ poll_media?: { text?: string } }>; allow_multiselect?: boolean }
    }

    expect(edit.poll?.answers?.map((answer) => answer.poll_media?.text)).toEqual([
      'Tuesday',
      'Thursday'
    ])
    expect(edit.poll?.allow_multiselect).toBe(true)
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
      expect.objectContaining({
        tools: [expect.anything(), ...Array(14).fill(expect.anything())]
      })
    )
    expect(disconnectMock).toHaveBeenCalledTimes(8)
  })

  it('gives the agent authenticated Mail MCP tools when Mail is configured', async () => {
    process.env.MAIL_API_KEY = 'pmail_test-key'

    await dispatch(agentCommandJSON('read my unread mail'), subs)

    expect(httpTransportMock).toHaveBeenCalledWith(
      new URL('https://mail.pmh.codes/api/external/v1/mcp'),
      { requestInit: { headers: { Authorization: 'Bearer pmail_test-key' } } }
    )
    expect(mcpClientMock).toHaveBeenCalledWith(
      expect.objectContaining({ applicationName: 'solver /a Mail' })
    )
    expect(agentMock).toHaveBeenCalledWith(
      expect.objectContaining({
        tools: [expect.anything(), ...Array(14).fill(expect.anything())]
      })
    )
    expect(disconnectMock).toHaveBeenCalledTimes(8)
  })

  it('keeps the agent available when Mail MCP authentication fails', async () => {
    process.env.MAIL_API_KEY = 'invalid-key'
    mcpToolFailures.push(false, false, false, false, false, false, false, true)

    const calls = await dispatch(agentCommandJSON('update my mail API key'), subs)

    expect(agentMock).toHaveBeenCalledWith(
      expect.objectContaining({
        tools: [expect.anything(), ...Array(13).fill(expect.anything())]
      })
    )
    expect(JSON.stringify(calls)).toContain('hello world')
    expect(JSON.stringify(calls)).not.toContain('MCP authentication failed')
    expect(disconnectMock).toHaveBeenCalledTimes(9)
  })

  it('gives the agent Google Calendar MCP tools when OAuth is configured', async () => {
    process.env.GOOGLE_OAUTH_CREDENTIALS_BASE64 = Buffer.from(
      JSON.stringify({
        web: { client_id: 'google-client-id', client_secret: 'google-client-secret' }
      })
    ).toString('base64')
    process.env.GOOGLE_CALENDAR_REDIRECT_URI = 'https://solver.example/mcp/google-calendar/callback'
    process.env.KV_STORE_PATH = join(googleCalendarTestDirectory, 'kv.sqlite')

    await dispatch(agentCommandJSON('show my calendar'), subs)

    expect(transportMock).toHaveBeenCalledWith({
      command: process.execPath,
      args: [expect.stringMatching(/@cocal\/google-calendar-mcp\/build\/index\.js$/)],
      env: expect.objectContaining({
        GOOGLE_OAUTH_CREDENTIALS: expect.stringMatching(
          /gpt-google-calendar-test\/\.google-calendar-mcp\/credentials\.json$/
        ),
        GOOGLE_CALENDAR_MCP_TOKEN_PATH: expect.stringMatching(
          /gpt-google-calendar-test\/\.google-calendar-mcp\/tokens\.json$/
        )
      })
    })
    expect(mcpClientMock).toHaveBeenCalledWith(
      expect.objectContaining({ applicationName: 'solver /a Google Calendar' })
    )
    expect(disconnectMock).toHaveBeenCalledTimes(8)
  })

  it('lets the agent attach, list, reuse, and remove a DB-backed MCP server', async () => {
    mcpToolGroups.push(
      ...Array.from({ length: 7 }, (_, index) => [{ name: `built_in_${index}` }]),
      [{ name: 'github_search', description: 'Search GitHub' }]
    )
    mcpActions.push({
      action: 'attach',
      name: 'github',
      transport: 'http',
      url: 'https://mcp.example.com/mcp',
      headers: { Authorization: 'Bearer secret-token' }
    })

    await dispatch(agentCommandJSON('attach the GitHub MCP'), subs)

    expect(JSON.parse(getStoredValue('gpt-mcp-servers')!)).toEqual([
      {
        name: 'github',
        transport: 'http',
        url: 'https://mcp.example.com/mcp',
        headers: { Authorization: 'Bearer secret-token' }
      }
    ])
    expect(httpTransportMock).toHaveBeenCalledWith(new URL('https://mcp.example.com/mcp'), {
      requestInit: { headers: { Authorization: 'Bearer secret-token' } }
    })
    expect(toolRegistryAddMock).toHaveBeenCalledWith([
      expect.objectContaining({ name: 'github_github_search' })
    ])
    expect(mcpActionResults.at(-1)).toBe(
      'Attached MCP server github with 1 tool: github_github_search.'
    )

    resetStoredValueConnection()
    mcpActions.push({ action: 'list' })
    await dispatch(agentCommandJSON('list attached MCP servers'), subs)

    expect(mcpActionResults.at(-1)).toBe(
      '[{"name":"github","transport":"http","url":"https://mcp.example.com/mcp","header_names":["Authorization"]}]'
    )
    expect(String(mcpActionResults.at(-1))).not.toContain('secret-token')
    expect(mcpClientMock).toHaveBeenCalledWith(
      expect.objectContaining({ applicationName: 'solver /a github' })
    )

    mcpActions.push({ action: 'remove', name: 'github' })
    await dispatch(agentCommandJSON('remove the GitHub MCP'), subs)

    expect(getStoredValue('gpt-mcp-servers')).toBe('[]')
    expect(mcpActionResults.at(-1)).toBe('Removed MCP server github.')
    expect(toolRegistryRemoveMock).toHaveBeenCalled()
  })

  it('replaces MCP tools whose names differ only by hyphens and underscores', async () => {
    mcpToolGroups.push(
      [
        { name: 'get-current-time', source: 'old' },
        { name: 'get_current_time', source: 'replacement' }
      ],
      ...Array.from({ length: 6 }, (_, index) => [{ name: `other_tool_${index}` }])
    )

    await dispatch(agentCommandJSON('what time is it?'), subs)

    const tools = (agentMock.mock.calls[0]![0] as { tools: Record<string, unknown>[] }).tools
    expect(tools).toContainEqual(
      expect.objectContaining({ name: 'docker_get_current_time', source: 'replacement' })
    )
    expect(tools).not.toContainEqual(expect.objectContaining({ name: 'docker_get-current-time' }))
    expect(tools).toHaveLength(14)
  })

  it('automatically diagnoses a closed MCP connection without MCP tools', async () => {
    streamMock.mockReturnValueOnce(new Error('MCP error -32000: Connection closed'))

    const calls = await dispatch(agentCommandJSON('list my containers'), subs)

    expect(agentMock).toHaveBeenCalledTimes(2)
    expect(agentMock).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        systemPrompt: expect.stringContaining('Diagnose the reported MCP connection failure'),
        tools: [
          expect.objectContaining({ name: 'shell' }),
          expect.objectContaining({ name: 'wait' }),
          expect.objectContaining({ name: 'publish_html' }),
          expect.objectContaining({ name: 'spotify_authenticate' }),
          expect.objectContaining({ name: 'google_calendar_authenticate' }),
          expect.objectContaining({ name: 'manage_mcp_servers' }),
          expect.objectContaining({ name: 'manage_response_modals' })
        ]
      })
    )
    expect(streamMock).toHaveBeenNthCalledWith(
      2,
      expect.stringMatching(
        /Docker MCP \(`uvx mcp-server-docker`\).*Filesystem MCP.*Playwright MCP/
      ),
      expect.anything()
    )
    expect(JSON.stringify(calls)).toContain('hello world')
    expect(JSON.stringify(calls)).not.toContain('error: MCP error -32000: Connection closed')
    expect(disconnectMock).toHaveBeenCalledTimes(7)
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
        params: {
          reasoning: { effort: 'high', summary: 'auto' },
          tools: [{ type: 'web_search' }]
        }
      })
    )
  })

  it('creates and lists web sessions with their persisted settings', async () => {
    const created = createWebSession('web-user', 'project notes')

    expect(created).toEqual({
      sessions: ['default', 'project notes'],
      selectedSession: 'project notes',
      settings: { model: 'gpt-5.4', effort: 'medium', maxTokens: 4096 }
    })

    await runWebAgent(
      {
        userId: 'web-user',
        sessionName: 'project notes',
        prompt: 'remember this',
        model: 'gpt-5.4-mini',
        effort: 'high',
        maxTokens: 2048
      },
      async () => undefined
    )

    expect(loadWebSessionState('web-user', 'project notes')).toEqual({
      sessions: ['default', 'project notes'],
      selectedSession: 'project notes',
      settings: { model: 'gpt-5.4-mini', effort: 'high', maxTokens: 2048 }
    })
    expect(() => createWebSession('web-user', ' ')).toThrow('Session name must not be empty')
  })

  it('restores a running web request and preserves its progress when cancelled', async () => {
    streamMock.mockReturnValueOnce('waitForAbort')
    const updates: unknown[] = []
    const running = runWebAgent(
      { userId: 'web-user', sessionName: 'work', prompt: 'long request', runId: 'run-one' },
      async (payload) => void updates.push(payload)
    )

    await vi.waitFor(() => {
      const active = loadWebConversation('web-user', 'work')
      expect(active.at(-1)).toMatchObject({
        role: 'assistant',
        status: 'running',
        runId: 'run-one'
      })
      expect(active.at(-1)?.content).toContain('Working through the request.')
    })

    await expect(cancelWebAgent('web-user', 'work', 'run-one')).resolves.toBe(true)
    await running

    expect(loadWebConversation('web-user', 'work')).toEqual([
      { role: 'user', content: 'long request' },
      expect.objectContaining({
        role: 'assistant',
        status: 'cancelled',
        content: expect.stringContaining('Working through the request.')
      })
    ])
    expect(JSON.stringify(updates.at(-1))).toContain('cancelled')
  })

  it('interrupts an active wait when the web request is cancelled', async () => {
    streamMock.mockReturnValueOnce('waitInTool')
    const running = runWebAgent(
      { userId: 'web-user', prompt: 'wait for deployment', runId: 'waiting-run' },
      async () => undefined
    )
    await vi.waitFor(() => expect(streamMock).toHaveBeenCalled())

    await expect(cancelWebAgent('web-user', 'default', 'waiting-run')).resolves.toBe(true)
    await running

    expect(loadWebConversation('web-user')).toEqual([
      { role: 'user', content: 'wait for deployment' },
      expect.objectContaining({ role: 'assistant', status: 'cancelled' })
    ])
  })

  it('cancels a running web request before appending its replacement', async () => {
    streamMock.mockReturnValueOnce('waitForAbort')
    const first = runWebAgent(
      { userId: 'web-user', prompt: 'first request', runId: 'first-run' },
      async () => undefined
    )
    await vi.waitFor(() => expect(loadWebConversation('web-user').at(-1)?.status).toBe('running'))

    const second = runWebAgent(
      { userId: 'web-user', prompt: 'replacement request', runId: 'second-run' },
      async () => undefined
    )
    await Promise.all([first, second])

    expect(loadWebConversation('web-user')).toEqual([
      { role: 'user', content: 'first request' },
      expect.objectContaining({ role: 'assistant', status: 'cancelled' }),
      { role: 'user', content: 'replacement request' },
      expect.objectContaining({
        role: 'assistant',
        content: expect.stringContaining('hello world')
      })
    ])
    const replacementOptions = agentMock.mock.calls.at(-1)?.[0] as { messages: unknown[] }
    expect(replacementOptions.messages).toEqual([
      { role: 'user', content: [{ text: 'first request' }] },
      { role: 'assistant', content: [{ text: 'Cancelled by user' }] }
    ])
  })

  it('shares session discovery between Discord and the web UI', async () => {
    await dispatch(agentCommandJSON('from Discord', {}, 'discord session'), subs)
    createWebSession('666666666666666666', 'web session')

    expect(loadWebSessionState('666666666666666666').sessions).toEqual([
      'default',
      'discord session',
      'web session'
    ])

    const calls = await dispatch(agentSessionAutocompleteJSON('web'), subs)
    const body = getCallback(calls) as { data: { choices: Array<{ name: string; value: string }> } }
    expect(body.data.choices).toEqual([{ name: 'web session', value: 'web session' }])
  })

  it('shares the selected session and conversation between Discord and the web UI', async () => {
    createWebSession('666666666666666666', 'shared session')
    await dispatch(agentCommandJSON('sent from Discord'), subs)

    expect(loadWebSessionState('666666666666666666').selectedSession).toBe('shared session')
    expect(loadWebConversation('666666666666666666', 'shared session')[0]).toEqual({
      role: 'user',
      content: 'sent from Discord'
    })
  })

  it('uses the same session namespace for an unrelated OIDC subject', async () => {
    await dispatch(agentCommandJSON('sent from Discord'), subs)

    expect(loadWebConversation('oidc|unrelated-subject', 'default')[0]).toEqual({
      role: 'user',
      content: 'sent from Discord'
    })
  })

  it('shows a running Discord request and its progress in the web UI conversation', async () => {
    streamMock.mockReturnValueOnce('waitForRelease')
    const running = dispatch(agentCommandJSON('sent from Discord'), subs)

    await vi.waitFor(() => {
      const conversation = loadWebConversation('666666666666666666', 'default')
      expect(conversation).toEqual([
        { role: 'user', content: 'sent from Discord', status: 'running' },
        expect.objectContaining({
          role: 'assistant',
          status: 'running',
          content: expect.stringContaining('Visible from the web UI.')
        })
      ])
    })

    streamRelease.resolve?.()
    await running
    expect(loadWebConversation('666666666666666666', 'default')).toEqual([
      { role: 'user', content: 'sent from Discord' },
      expect.objectContaining({ role: 'assistant' })
    ])
  })

  it('includes sessions from legacy web indexes and persisted conversations', () => {
    setStoredValue('gpt-web-sessions', JSON.stringify(['legacy web']))
    setStoredValue('gpt-session:legacy%20discord', '[]')

    expect(loadWebSessionState('shared-user').sessions).toEqual([
      'default',
      'legacy discord',
      'legacy web'
    ])
  })

  it('passes through and persists a model outside the suggestion list', async () => {
    await dispatch(
      agentCommandJSON('configure custom model', {}, 'custom', {
        model: 'vendor/custom-model-preview'
      }),
      subs
    )
    await dispatch(agentCommandJSON('reuse custom model', {}, 'custom'), subs)

    expect(modelMock).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ modelId: 'vendor/custom-model-preview' })
    )
    expect(modelMock).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ modelId: 'vendor/custom-model-preview' })
    )
    expect(getStoredValue('gpt-settings:custom')).toContain('"model":"vendor/custom-model-preview"')
  })

  it('retains full conversation history in the selected session', async () => {
    await dispatch(agentCommandJSON('first question'), subs)
    await dispatch(agentCommandJSON('second question'), subs)

    expectStoredAgentHistory(-1, 'first question')
  })

  it('resets an /a session after one hour without a command', async () => {
    let now = 1_000_000
    vi.spyOn(Date, 'now').mockImplementation(() => now)
    await dispatch(agentCommandJSON('remember this'), subs)

    now += 60 * 60 * 1000
    expect(loadWebConversation('666666666666666666')).toEqual([])
    await dispatch(agentCommandJSON('new topic'), subs)

    expect(agentMock.mock.calls.at(-1)?.[0]).toMatchObject({ messages: [] })
    expect(getStoredValue('gpt-session-activity:default')).toBe(String(now))
  })

  it('resets idle Web UI history after one hour without a command', async () => {
    let now = 2_000_000
    vi.spyOn(Date, 'now').mockImplementation(() => now)
    await runWebAgent({ userId: 'web-user', prompt: 'remember this' }, async () => undefined)

    now += 60 * 60 * 1000
    expect(loadWebConversation('web-user')).toEqual([])
    await runWebAgent({ userId: 'web-user', prompt: 'new topic' }, async () => undefined)

    expect(agentMock.mock.calls.at(-1)?.[0]).toMatchObject({ messages: [] })
  })

  it('loads legacy text history and upgrades it after the next response', async () => {
    setStoredValue(
      'gpt-session:default',
      JSON.stringify([
        { role: 'user', content: 'legacy question' },
        { role: 'assistant', content: '{"content":"legacy answer"}' }
      ])
    )

    await runWebAgent({ userId: 'web-user', prompt: 'continue' }, async () => undefined)

    expect(agentMock).toHaveBeenLastCalledWith(
      expect.objectContaining({
        messages: [
          { role: 'user', content: [{ text: 'legacy question' }] },
          { role: 'assistant', content: [{ text: '{"content":"legacy answer"}' }] }
        ]
      })
    )
    const upgraded = JSON.parse(getStoredValue('gpt-session:default')!) as {
      version: number
      turns: unknown[]
    }
    expect(upgraded.version).toBe(2)
    expect(upgraded.turns.slice(0, 3)).toEqual([
      { role: 'user', content: 'legacy question' },
      { role: 'assistant', content: '{"content":"legacy answer"}' },
      { role: 'user', content: 'continue' }
    ])
  })

  it('clears the selected session history without invoking the agent', async () => {
    await dispatch(agentCommandJSON('work question', {}, 'work'), subs)
    expect(getStoredValue('gpt-session:work')).not.toBe('[]')

    const cleared = await dispatch(agentCommandJSON('/clear'), subs)
    const clearEdit = cleared.filter((call) => call.method === 'PATCH').at(-1)?.body

    expect(JSON.stringify(clearEdit)).toContain('**/clear**')
    expect(JSON.stringify(clearEdit)).toContain('Cleared history for session `work`.')
    expect(getStoredValue('gpt-session:work')).toBe('[]')
    expect(agentMock).toHaveBeenCalledTimes(1)

    await dispatch(agentCommandJSON('start fresh'), subs)
    expect(agentMock).toHaveBeenCalledTimes(2)
    expect(agentMock).toHaveBeenLastCalledWith(expect.objectContaining({ messages: [] }))
  })

  it('lets the agent create multiple component rows and rewrites the response on interaction', async () => {
    componentActions.push({
      action: 'set',
      components_json: JSON.stringify([
        {
          type: 1,
          components: [
            { type: 2, custom_id: 'show-details', label: 'Show details', style: 1 },
            { type: 2, custom_id: 'download', label: 'Download', style: 2 }
          ]
        },
        {
          type: 1,
          components: [
            {
              type: 3,
              custom_id: 'format',
              placeholder: 'Choose a format',
              sender_only: false,
              options: [{ label: 'PDF', value: 'pdf' }]
            }
          ]
        }
      ])
    })
    const initialCalls = await dispatch(agentCommandJSON('summarize the report'), subs)
    const initialEdit = initialCalls.filter((call) => call.method === 'PATCH').at(-1)?.body as {
      components: unknown[]
    }
    expect(JSON.stringify(initialEdit)).toContain(`${GPT_ACTION_COMPONENT_ID}:`)
    expect(JSON.stringify(initialEdit)).toContain('Show details')
    expect(JSON.stringify(initialEdit)).toContain('Choose a format')
    const formatId = JSON.stringify(initialEdit).match(/gpt-action:[^"]+:format/)?.[0]
    expect(formatId).toBeTruthy()

    componentActions.push({ action: 'clear' })
    const clickCalls = await dispatch(
      selectJSON(initialEdit.components, formatId!, 'pdf', {
        user: {
          id: '555555555555555555',
          username: 'otheruser',
          discriminator: '0',
          avatar: null,
          global_name: 'Other User'
        }
      }),
      subs
    )

    expect(getCallback(clickCalls)).toMatchObject({
      type: InteractionResponseType.DeferredMessageUpdate
    })
    expect(streamMock).toHaveBeenLastCalledWith(
      JSON.stringify({ type: 'discord_component', custom_id: 'format', values: ['pdf'] }),
      expect.anything()
    )
    expect(agentMock).toHaveBeenLastCalledWith(
      expect.objectContaining({
        messages: expect.arrayContaining([
          expect.objectContaining({
            role: 'assistant',
            content: [{ text: expect.stringContaining('{"content":"hello world","components":') }]
          })
        ])
      })
    )
    const rewritten = clickCalls.filter((call) => call.method === 'PATCH').at(-1)?.body
    expect(JSON.stringify(rewritten)).toContain('hello world')
    expect(JSON.stringify(rewritten)).not.toContain(GPT_ACTION_COMPONENT_ID)
  })

  it('restricts sender-only components while leaving the parameter out of Discord JSON', async () => {
    responsePayloads.push({
      content: 'Choose an action',
      components: [
        {
          type: 1,
          components: [
            {
              type: 2,
              custom_id: 'private-action',
              label: 'Private action',
              style: 1,
              sender_only: true
            }
          ]
        }
      ]
    })
    const initialCalls = await dispatch(agentCommandJSON('create a private action'), subs)
    const initialEdit = initialCalls.filter((call) => call.method === 'PATCH').at(-1)?.body as {
      components: unknown[]
    }
    const actionId = JSON.stringify(initialEdit).match(/gpt-action:[^"]+:private-action/)?.[0]

    expect(actionId).toBeTruthy()
    expect(JSON.stringify(initialEdit)).not.toContain('sender_only')

    const unauthorizedCalls = await dispatch(
      buttonJSON(initialEdit.components, actionId!, {
        user: {
          id: '555555555555555555',
          username: 'otheruser',
          discriminator: '0',
          avatar: null,
          global_name: 'Other User'
        }
      }),
      subs
    )
    const unauthorized = getCallback(unauthorizedCalls) as {
      type: number
      data: { flags: number; components: unknown[] }
    }
    expect(unauthorized.type).toBe(InteractionResponseType.ChannelMessageWithSource)
    expect(unauthorized.data.flags & MessageFlags.Ephemeral).toBeTruthy()
    expect(JSON.stringify(unauthorized.data.components)).toContain(
      'only the user who sent this request can use this component'
    )
    expect(streamMock).toHaveBeenCalledTimes(1)

    const ownerCalls = await dispatch(buttonJSON(initialEdit.components, actionId!), subs)
    expect(getCallback(ownerCalls)).toMatchObject({
      type: InteractionResponseType.DeferredMessageUpdate
    })
    expect(streamMock).toHaveBeenCalledTimes(2)
  })

  it('persists web button payloads and routes custom-id clicks through the agent interaction flow', async () => {
    responsePayloads.push({
      content: 'Choose an action',
      components: [
        {
          type: 1,
          components: [
            {
              type: 2,
              custom_id: 'continue',
              label: 'Continue',
              style: 1,
              emoji: { name: '▶️' },
              sender_only: true
            },
            {
              type: 2,
              label: 'Documentation',
              style: 5,
              url: 'https://example.com/docs'
            },
            {
              type: 2,
              custom_id: 'disabled',
              label: 'Unavailable',
              style: 4,
              disabled: true
            }
          ]
        }
      ]
    })
    const updates: unknown[] = []
    await runWebAgent(
      { userId: 'web-user', prompt: 'give me choices' },
      async (payload) => void updates.push(payload)
    )

    const rendered = updates.at(-1) as { components: unknown[] }
    const renderedJson = JSON.stringify(rendered)
    const customId = renderedJson.match(/gpt-action:[^"]+:continue/)?.[0]
    expect(customId).toBeTruthy()
    expect(renderedJson).toContain('https://example.com/docs')
    expect(renderedJson).toContain('▶️')
    expect(renderedJson).toContain('Unavailable')
    expect(renderedJson).not.toContain('sender_only')
    expect(loadWebConversation('web-user').at(-1)?.content).toBe(renderedJson)

    responsePayloads.push({ content: 'Continued from the button' })
    const interactionUpdates: unknown[] = []
    await runWebComponentInteraction(
      { userId: 'web-user', customId: customId! },
      async (payload) => void interactionUpdates.push(payload)
    )

    expect(streamMock).toHaveBeenLastCalledWith(
      JSON.stringify({ type: 'discord_component', custom_id: 'continue', values: [] }),
      expect.anything()
    )
    expect(JSON.stringify(interactionUpdates.at(-1))).toContain('Continued from the button')
    expect(loadWebConversation('web-user')).toEqual([
      { role: 'user', content: 'give me choices' },
      expect.objectContaining({ role: 'assistant', content: expect.stringContaining('Continued') })
    ])
  })

  it('accepts every Discord message component type', async () => {
    componentActions.push({
      action: 'set',
      components_json: JSON.stringify([
        {
          type: 17,
          accent_color: 1082239,
          components: [
            { type: 10, content: 'Extra context' },
            {
              type: 9,
              components: [{ type: 10, content: 'Section content' }],
              accessory: { type: 11, media: { url: 'https://example.com/image.png' } }
            },
            {
              type: 12,
              items: [{ media: { url: 'https://example.com/gallery.png' } }]
            },
            { type: 14, divider: true, spacing: 1 },
            { type: 13, file: { url: 'attachment://report.txt' } }
          ]
        },
        {
          type: 1,
          components: [{ type: 5, custom_id: 'user', placeholder: 'User' }]
        },
        {
          type: 1,
          components: [{ type: 6, custom_id: 'role', placeholder: 'Role' }]
        },
        {
          type: 1,
          components: [{ type: 7, custom_id: 'mention', placeholder: 'Mentionable' }]
        },
        {
          type: 1,
          components: [{ type: 8, custom_id: 'channel', placeholder: 'Channel' }]
        }
      ])
    })

    const calls = await dispatch(agentCommandJSON('build a dashboard'), subs)
    const edit = calls.filter((call) => call.method === 'PATCH').at(-1)?.body
    const rendered = JSON.stringify(edit)

    for (const type of [5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 17]) {
      expect(rendered).toContain(`"type":${type}`)
    }
  })

  it('opens agent-defined modals and sends every submitted field back as JSON', async () => {
    modalActions.push({
      action: 'set',
      trigger_id: 'configure',
      modal_json: JSON.stringify({
        title: 'Configure report',
        components: [
          {
            type: 1,
            components: [{ type: 4, custom_id: 'topic', label: 'Topic', style: 1, required: true }]
          }
        ]
      })
    })
    responsePayloads.push({
      content: 'Choose settings',
      components: [
        {
          type: 1,
          components: [{ type: 2, custom_id: 'configure', label: 'Configure', style: 1 }]
        }
      ]
    })

    const initialCalls = await dispatch(agentCommandJSON('build a configurable report'), subs)
    const initialEdit = initialCalls.filter((call) => call.method === 'PATCH').at(-1)?.body as {
      components: unknown[]
    }
    const configureId = JSON.stringify(initialEdit).match(/gpt-action:[^"]+:configure/)?.[0]
    expect(configureId).toBeTruthy()

    const openCalls = await dispatch(buttonJSON(initialEdit.components, configureId!), subs)
    const open = getCallback(openCalls) as { type: number; data: { custom_id: string } }
    expect(open.type).toBe(InteractionResponseType.Modal)
    expect(open.data.custom_id).toMatch(new RegExp(`^${GPT_MODAL_ID}:[^:]+:configure$`))

    const submitCalls = await dispatch(
      modalJSON('quarterly revenue', {}, { customId: open.data.custom_id, inputId: 'topic' }),
      subs
    )
    expect(getCallback(submitCalls)).toMatchObject({
      type: InteractionResponseType.DeferredMessageUpdate
    })
    expect(streamMock).toHaveBeenLastCalledWith(
      JSON.stringify({
        type: 'discord_modal_submit',
        trigger_id: 'configure',
        fields: [{ custom_id: 'topic', type: 4, value: 'quarterly revenue' }]
      }),
      expect.anything()
    )
  })

  it('routes web buttons and every select family through the Discord interaction protocol', async () => {
    const webComponents = [
      {
        type: 1,
        components: [
          { type: 2, custom_id: 'continue', label: 'Continue', style: 1 },
          {
            type: 3,
            custom_id: 'format',
            placeholder: 'Format',
            min_values: 1,
            max_values: 2,
            options: [
              { label: 'PDF', value: 'pdf', default: true },
              { label: 'HTML', value: 'html' }
            ]
          }
        ]
      },
      {
        type: 1,
        components: [
          {
            type: 5,
            custom_id: 'user',
            default_values: [{ id: '111111111111111111', type: 'user' }]
          }
        ]
      },
      { type: 1, components: [{ type: 6, custom_id: 'role' }] },
      { type: 1, components: [{ type: 7, custom_id: 'mentionable' }] },
      { type: 1, components: [{ type: 8, custom_id: 'channel' }] }
    ]
    componentActions.push({
      action: 'set',
      components_json: JSON.stringify(webComponents)
    })
    const updates: unknown[] = []
    await runWebAgent({ userId: 'web-owner', prompt: 'build controls' }, async (payload) => {
      updates.push(payload)
    })
    const rendered = JSON.stringify(updates.at(-1))

    for (const [stableId, values] of [
      ['continue', []],
      ['format', ['pdf', 'html']],
      ['user', ['111111111111111111']],
      ['role', ['222222222222222222']],
      ['mentionable', ['333333333333333333']],
      ['channel', ['444444444444444444']]
    ] as const) {
      const customId = rendered.match(new RegExp(`gpt-action:[^"\\\\]+:${stableId}`))?.[0]
      expect(customId).toBeTruthy()
      responsePayloads.push({ content: 'updated', components: webComponents })
      await runWebInteraction(
        { userId: 'web-owner', customId: customId!, values: [...values] },
        async () => {}
      )
      expect(streamMock).toHaveBeenLastCalledWith(
        JSON.stringify({ type: 'discord_component', custom_id: stableId, values }),
        expect.anything()
      )
    }
  })

  it('opens and validates web modals before sending Discord-shaped fields', async () => {
    modalActions.push({
      action: 'set',
      trigger_id: 'configure',
      modal_json: JSON.stringify({
        title: 'Configure report',
        components: [
          {
            type: 1,
            components: [
              {
                type: 4,
                custom_id: 'topic',
                label: 'Topic',
                style: 1,
                min_length: 3,
                required: true
              }
            ]
          }
        ]
      })
    })
    responsePayloads.push({
      content: 'Choose settings',
      components: [
        {
          type: 1,
          components: [{ type: 2, custom_id: 'configure', label: 'Configure', style: 1 }]
        }
      ]
    })
    const updates: unknown[] = []
    await runWebAgent({ userId: 'web-owner', prompt: 'configure' }, async (payload) => {
      updates.push(payload)
    })
    const actionId = JSON.stringify(updates.at(-1)).match(/gpt-action:[^"\\]+:configure/)?.[0]
    const opened = await runWebInteraction(
      { userId: 'web-owner', customId: actionId! },
      async () => {}
    )
    expect(opened).toMatchObject({ modal: { title: 'Configure report' } })
    const modalId = 'modal' in opened ? String(opened.modal.custom_id) : ''

    await expect(
      runWebInteraction(
        {
          userId: 'web-owner',
          customId: modalId,
          fields: [{ custom_id: 'topic', type: 4, value: 'no' }]
        },
        async () => {}
      )
    ).rejects.toThrow('Modal field validation failed')

    await expect(
      runWebInteraction(
        {
          userId: 'web-owner',
          customId: modalId,
          fields: [{ custom_id: 'topic', type: 4, value: '' }]
        },
        async () => {}
      )
    ).rejects.toThrow('Modal field validation failed')

    responsePayloads.push({ content: 'configured' })
    await runWebInteraction(
      {
        userId: 'web-owner',
        customId: modalId,
        fields: [{ custom_id: 'topic', type: 4, value: 'quarterly revenue' }]
      },
      async () => {}
    )
    expect(streamMock).toHaveBeenLastCalledWith(
      JSON.stringify({
        type: 'discord_modal_submit',
        trigger_id: 'configure',
        fields: [{ custom_id: 'topic', type: 4, value: 'quarterly revenue' }]
      }),
      expect.anything()
    )
  })

  it('uses Discord modal value shapes for optional radio and checkbox groups', async () => {
    modalActions.push({
      action: 'set',
      trigger_id: 'preferences',
      modal_json: JSON.stringify({
        title: 'Preferences',
        components: [
          {
            type: 18,
            label: 'Frequency',
            component: {
              type: 21,
              custom_id: 'frequency',
              required: false,
              options: [
                { label: 'Daily', value: 'daily' },
                { label: 'Weekly', value: 'weekly' }
              ]
            }
          },
          {
            type: 18,
            label: 'Sections',
            component: {
              type: 22,
              custom_id: 'sections',
              required: false,
              min_values: 0,
              max_values: 2,
              options: [
                { label: 'Summary', value: 'summary' },
                { label: 'Details', value: 'details' }
              ]
            }
          }
        ]
      })
    })
    responsePayloads.push({
      components: [
        {
          type: 1,
          components: [{ type: 2, custom_id: 'preferences', label: 'Preferences', style: 1 }]
        }
      ]
    })
    const updates: unknown[] = []
    await runWebAgent({ userId: 'web-owner', prompt: 'preferences' }, async (payload) => {
      updates.push(payload)
    })
    const actionId = JSON.stringify(updates.at(-1)).match(/gpt-action:[^"\\]+:preferences/)?.[0]
    const opened = await runWebInteraction(
      { userId: 'web-owner', customId: actionId! },
      async () => {}
    )
    const modalId = 'modal' in opened ? String(opened.modal.custom_id) : ''

    responsePayloads.push({ content: 'saved' })
    await runWebInteraction(
      {
        userId: 'web-owner',
        customId: modalId,
        fields: [
          { custom_id: 'frequency', type: 21, value: null },
          { custom_id: 'sections', type: 22, values: [] }
        ]
      },
      async () => {}
    )
    expect(streamMock).toHaveBeenLastCalledWith(
      JSON.stringify({
        type: 'discord_modal_submit',
        trigger_id: 'preferences',
        fields: [
          { custom_id: 'frequency', type: 21, value: null },
          { custom_id: 'sections', type: 22, values: [] }
        ]
      }),
      expect.anything()
    )
  })

  it('allows sender-only components through the authenticated single-user web UI', async () => {
    responsePayloads.push({
      content: 'Private action',
      components: [
        {
          type: 1,
          components: [
            {
              type: 2,
              custom_id: 'private-action',
              label: 'Private action',
              style: 1,
              sender_only: true
            }
          ]
        }
      ]
    })
    const updates: unknown[] = []
    await runWebAgent({ userId: 'web-owner', prompt: 'private control' }, async (payload) => {
      updates.push(payload)
    })
    const customId = JSON.stringify(updates.at(-1)).match(/gpt-action:[^"\\]+:private-action/)?.[0]

    responsePayloads.push({ content: 'Private action completed' })
    await expect(
      runWebInteraction({ userId: 'another-user', customId: customId! }, async () => {})
    ).resolves.toEqual({ updated: true })
    expect(streamMock).toHaveBeenCalledTimes(2)
  })

  it('rejects unsupported web modal field submissions without running the agent', async () => {
    modalActions.push({
      action: 'set',
      trigger_id: 'upload',
      modal_json: JSON.stringify({
        title: 'Upload a file',
        components: [
          {
            type: 18,
            label: 'Attachment',
            component: { type: 19, custom_id: 'attachment', required: false }
          }
        ]
      })
    })
    responsePayloads.push({
      components: [
        {
          type: 1,
          components: [{ type: 2, custom_id: 'upload', label: 'Upload', style: 1 }]
        }
      ]
    })
    const updates: unknown[] = []
    await runWebAgent({ userId: 'web-owner', prompt: 'upload' }, async (payload) => {
      updates.push(payload)
    })
    const actionId = JSON.stringify(updates.at(-1)).match(/gpt-action:[^"\\]+:upload/)?.[0]
    const opened = await runWebInteraction(
      { userId: 'web-owner', customId: actionId! },
      async () => {}
    )
    const modalId = 'modal' in opened ? String(opened.modal.custom_id) : ''

    await expect(
      runWebInteraction(
        {
          userId: 'web-owner',
          customId: modalId,
          fields: [{ custom_id: 'attachment', type: 19 }]
        },
        async () => {}
      )
    ).rejects.toThrow('Unsupported modal field type')
    expect(streamMock).toHaveBeenCalledTimes(1)
  })

  it('switches to a new session and keeps it selected', async () => {
    await dispatch(agentCommandJSON('default question'), subs)
    const switched = await dispatch(agentCommandJSON('work question', {}, 'work'), subs)
    const continued = await dispatch(agentCommandJSON('follow-up'), subs)

    expect(JSON.stringify(switched)).toContain('hello world')
    expect(JSON.stringify(continued)).toContain('hello world')
    expectStoredAgentHistory(-1, 'work question')
  })

  it('serializes overlapping requests in the same session', async () => {
    await Promise.all([
      dispatch(agentCommandJSON('first concurrent question'), subs),
      dispatch(agentCommandJSON('second concurrent question'), subs)
    ])

    expectStoredAgentHistory(1, 'first concurrent question')
  })

  it('does not inject session metadata into agent-owned output', async () => {
    const calls = await dispatch(agentCommandJSON('question', {}, 'work\n# notes'), subs)

    expect(JSON.stringify(calls)).toContain('hello world')
    expect(JSON.stringify(calls)).not.toContain('Session:')
  })

  it('edits reply when no API token is configured', async () => {
    delete process.env.OPENAI_API_KEY
    const calls = await dispatch(agentCommandJSON('what is 2+2'), subs)
    const defer = getCallback(calls) as { type: number }
    expect(defer.type).toBe(InteractionResponseType.DeferredChannelMessageWithSource)
    const edit = getEdit(calls) as { components?: unknown } | null
    expect(edit).not.toBeNull()
    expect(JSON.parse(getStoredValue('gpt-session:default')!)).toMatchObject({
      version: 2,
      messages: [
        { role: 'user', content: [{ text: 'what is 2+2' }] },
        { role: 'assistant', content: [{ text: 'no OpenAI API token configured' }] }
      ]
    })
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
