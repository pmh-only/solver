import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  InteractionResponseType,
  MessageFlags,
  type Interaction,
  type RepliableInteraction
} from 'discord.js'
import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import { agentCommand } from '../application-commands.js'
import {
  GPT_ACTION_COMPONENT_ID,
  GPT_MODAL_ID,
  cancelWebAgent,
  closeAgentMcpRuntime,
  createWebSession,
  loadWebConversation,
  loadWebSessionState,
  recoverInteractionWithAgent,
  runWebAgent,
  runDynamicAgentFeature,
  runWebComponentInteraction,
  runWebInteraction
} from '../agent/index.js'
import {
  clearStoredValues,
  getStoredValue,
  resetStoredValueConnection,
  setStoredValue
} from '../helpers/kv-store.js'
import { getAgentMemoryPath } from '../helpers/agent-memory-path.js'
import { clearModelCache } from '../model-catalog.js'
import { updateOpenAIToken } from '../openai-config.js'
import { updateSystemPrompt } from '../system-prompt.js'
import {
  type DynamicDiscordFeatureManager,
  setDynamicDiscordFeatureManager
} from '../dynamic-features.js'
import { clearRuntimeIssuesForTests, reportRuntimeIssue } from '../runtime-health.js'
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
  modelMiddlewareHandlers,
  modelMock,
  componentActions,
  modalActions,
  registeredAgentTools,
  responsePayloads,
  streamRelease,
  responseIds,
  subagentCancelMock,
  subagentInvokeMock,
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
    modelMiddlewareHandlers: [] as Array<(context: never) => Promise<unknown>>,
    modelMock: vi.fn(),
    componentActions: [] as Record<string, unknown>[],
    modalActions: [] as Record<string, unknown>[],
    responsePayloads: [] as unknown[],
    responseIds: [] as string[],
    subagentCancelMock: vi.fn(),
    subagentInvokeMock: vi.fn(async (prompt: string, _options?: unknown) => ({
      stopReason: 'endTurn',
      toString: () => `finding: ${prompt}`
    })),
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
  InvokeModelStage: { Input: {} },
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
    private modelStateValues: Record<string, unknown>
    modelState: {
      get: (key: string) => unknown
      set: (key: string, value: unknown) => void
    }
    addMiddleware = vi.fn((_stage: unknown, handler: (context: never) => Promise<unknown>) => {
      modelMiddlewareHandlers.push(handler)
    })
    cancel = subagentCancelMock

    constructor(options: unknown) {
      agentMock(options)
      this.options = options as typeof this.options
      this.modelStateValues = {
        ...(options as { modelState?: Record<string, unknown> }).modelState
      }
      this.modelState = {
        get: (key) => this.modelStateValues[key],
        set: (key, value) => {
          this.modelStateValues[key] = value
        }
      }
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

    invoke(prompt: string, options: unknown) {
      return subagentInvokeMock(prompt, options)
    }

    private message(data: { role: 'user' | 'assistant'; content: Record<string, unknown>[] }) {
      const serialized = structuredClone(data)
      return { ...serialized, toJSON: () => structuredClone(serialized) }
    }

    async *stream(prompt: unknown, options: unknown) {
      this.messages.push(
        this.message({
          role: 'user',
          content:
            typeof prompt === 'string'
              ? [{ text: prompt }]
              : structuredClone(prompt as Record<string, unknown>[])
        })
      )
      const streamResult = streamMock(prompt, options)
      yield { type: 'beforeModelCallEvent' }
      yield {
        type: 'modelStreamUpdateEvent',
        event: { type: 'modelMessageStartEvent', role: 'assistant' }
      }
      const responseId = responseIds.shift()
      if (responseId) this.modelState.set('responseId', responseId)
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
      if (
        streamResult === 'throwAfterActivity' ||
        streamResult === 'streamIncompleteAfterActivity'
      ) {
        if (streamResult === 'streamIncompleteAfterActivity') {
          throw Object.assign(
            new Error('502 Upstream websocket closed before response.completed'),
            { status: 502, code: 'stream_incomplete' }
          )
        }
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
                  components: [
                    { type: 10, content: 'hello world' },
                    ...(typeof componentAction?.components_json === 'string'
                      ? JSON.parse(componentAction.components_json)
                      : [])
                  ],
                  flags: MessageFlags.IsComponentsV2
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
    {
      role: 'assistant',
      content: [
        {
          text: '{"components":[{"type":10,"content":"hello world"}],"flags":32768}'
        }
      ]
    }
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
  responseIds.length = 0
  streamRelease.resolve = undefined
  mcpToolGroups.length = 0
  mcpToolNumber.value = 0
  modelMiddlewareHandlers.length = 0
  clearModelCache()
  clearRuntimeIssuesForTests()
  clearStoredValues()
})

afterEach(async () => {
  setDynamicDiscordFeatureManager(undefined)
  clearRuntimeIssuesForTests()
  await closeAgentMcpRuntime()
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
      'attachment',
      'session',
      'model',
      'effort',
      'tokens',
      'tools',
      'system_prompt',
      'reset_system_prompt',
      'openai_endpoint',
      'reset_openai_endpoint',
      'debug'
    ])
    expect(command.options?.[0]).toMatchObject({ name: 'prompt', required: true })
    expect(command.options?.[1]).toMatchObject({
      name: 'attachment',
      required: false,
      type: 11
    })
    expect(command.options?.[2]).toMatchObject({
      name: 'session',
      required: false,
      autocomplete: true
    })
    expect(command.options?.[3]).toMatchObject({
      name: 'model',
      required: false,
      autocomplete: true
    })
    expect(command.options?.[4]).toMatchObject({ name: 'effort', required: false })
    expect(command.options?.[5]).toMatchObject({
      name: 'tokens',
      required: false,
      min_value: 256,
      max_value: 16384
    })
    expect(command.options?.[6]).toMatchObject({ name: 'tools', required: false })
  })

  it('runs dynamic feature instructions as ephemeral agent requests', async () => {
    const deferReply = vi.fn(async () => {})
    const editReply = vi.fn(async () => ({ id: 'dynamic-response' }))
    const followUp = vi.fn(async () => ({}))
    const interaction = {
      user: { id: '666666666666666666' },
      deferReply,
      editReply,
      followUp
    } as unknown as RepliableInteraction

    await runDynamicAgentFeature(
      interaction,
      {
        id: 'summarize',
        kind: 'command',
        name: 'summarize',
        description: 'summarize text',
        instructions: 'Return exactly three concise bullets.'
      },
      '{"type":"command","arguments":"report"}',
      false
    )

    expect(deferReply).toHaveBeenCalledWith({ flags: MessageFlags.Ephemeral })
    expect(streamMock).toHaveBeenCalledWith(
      '{"type":"command","arguments":"report"}',
      expect.objectContaining({ cancelSignal: expect.any(AbortSignal) })
    )
    expect(agentMock).toHaveBeenCalledWith(
      expect.objectContaining({
        systemPrompt: expect.stringContaining('Return exactly three concise bullets.'),
        tools: expect.arrayContaining([
          expect.objectContaining({ name: 'manage_discord_features' })
        ])
      })
    )

    const manage = vi.fn(async () => 'Created command Discord feature summarize as /c summarize.')
    setDynamicDiscordFeatureManager({ manage } as unknown as DynamicDiscordFeatureManager)
    const managementTool = registeredAgentTools.get('manage_discord_features') as {
      callback: (input: Record<string, unknown>) => Promise<string>
    }
    await expect(
      managementTool.callback({
        action: 'upsert',
        id: 'summarize',
        kind: 'command',
        name: 'summarize',
        description: 'summarize text',
        instructions: 'Return exactly three concise bullets.'
      })
    ).resolves.toContain('Created command Discord feature')
    expect(manage).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'upsert', id: 'summarize', kind: 'command' })
    )

    await expect(
      managementTool.callback({
        action: 'upsert',
        id: 'hello',
        kind: 'command',
        name: 'hello',
        description: 'say hello',
        code: 'return "안녕"'
      })
    ).resolves.toContain('Created command Discord feature')
    expect(manage).toHaveBeenLastCalledWith(
      expect.objectContaining({
        action: 'upsert',
        id: 'hello',
        code: 'return "안녕"',
        instructions: undefined
      })
    )

    manage.mockRejectedValueOnce(
      new Error('deploy https://discord.example/webhooks/123/secret-token?key=secret failed')
    )
    const failed = await managementTool.callback({ action: 'remove', id: 'summarize' })
    expect(failed).toContain('failed safely and was rolled back')
    expect(failed).toContain('Diagnose the cause')
    expect(failed).not.toContain('secret-token')
  })

  it('tells the next agent run to repair safely redacted runtime failures', async () => {
    reportRuntimeIssue(
      'application_command_deployment',
      new Error('failed https://discord.example/webhooks/123/secret-token?key=secret')
    )

    await dispatch(agentCommandJSON('check runtime health'), subs)

    const systemPrompt = String(agentMock.mock.calls[0]?.[0].systemPrompt)
    expect(systemPrompt).toContain('Runtime failures awaiting repair')
    expect(systemPrompt).toContain('untrusted diagnostic data')
    expect(systemPrompt).toContain('application_command_deployment')
    expect(systemPrompt).not.toContain('secret-token')
  })

  it('contains failed automatic recovery and delivers a non-recursive fallback', async () => {
    const editReply = vi
      .fn()
      .mockRejectedValueOnce(new Error('recovery progress failed'))
      .mockResolvedValueOnce({ id: 'fallback' })
    const interaction = {
      type: 2,
      user: { id: '666666666666666666' },
      commandName: 'broken',
      deferred: true,
      replied: false,
      isAutocomplete: () => false,
      isRepliable: () => true,
      deferReply: vi.fn(),
      editReply,
      followUp: vi.fn(),
      reply: vi.fn()
    } as unknown as Interaction
    vi.spyOn(console, 'error').mockImplementation(() => {})

    await expect(
      recoverInteractionWithAgent(interaction, new Error('original failure'), 'test handler')
    ).resolves.toBeUndefined()

    expect(editReply).toHaveBeenCalledTimes(2)
    expect(JSON.stringify(editReply.mock.calls[1]?.[0])).toContain(
      'automatic recovery was unavailable'
    )
  })

  it('downloads a safely named photo and passes its bytes to the agent', async () => {
    const image = Uint8Array.from([0x89, 0x50, 0x4e, 0x47])
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(image, { headers: { 'content-type': 'image/png' } }))

    const calls = await dispatch(
      agentCommandJSON('describe this', {}, undefined, {
        attachment: {
          name: '../../quarterly report.png',
          size: image.byteLength,
          contentType: 'image/png'
        }
      }),
      subs
    )

    expect(fetchMock).toHaveBeenCalledWith(
      expect.objectContaining({ hostname: 'cdn.discordapp.com' }),
      expect.objectContaining({ redirect: 'error', signal: expect.any(AbortSignal) })
    )
    expect(streamMock).toHaveBeenCalledWith(
      [
        { text: 'describe this\n\nAttached file: quarterly_report.png' },
        { image: { format: 'png', source: { bytes: image } } }
      ],
      expect.anything()
    )
    const edits = calls.filter((call) => call.method === 'PATCH').map((call) => call.body) as Array<
      Record<string, unknown>
    >
    expect(edits.at(-1)?.content ?? '').toBe('')
    expect(JSON.stringify(edits)).toContain('quarterly')
    expect(JSON.stringify(edits)).not.toContain('../')
  })

  it('passes supported documents to the agent with a safe filename', async () => {
    const document = new TextEncoder().encode('{"status":"ok"}')
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(document, { headers: { 'content-type': 'application/json' } })
    )

    await dispatch(
      agentCommandJSON('summarize', {}, undefined, {
        attachment: {
          name: '..\\unsafe name.json',
          size: document.byteLength,
          contentType: 'application/json'
        }
      }),
      subs
    )

    expect(streamMock.mock.calls[0]?.[0]).toEqual([
      { text: 'summarize\n\nAttached file: unsafe_name.json' },
      {
        document: {
          name: 'unsafe_name.json',
          format: 'json',
          source: { bytes: document }
        }
      }
    ])
  })

  it('returns a content-free Components V2 error for invalid attachment types', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const calls = await dispatch(
      agentCommandJSON('inspect', {}, undefined, {
        attachment: {
          name: 'payload.exe',
          size: 100,
          contentType: 'application/octet-stream'
        }
      }),
      subs
    )
    const callback = getCallback(calls) as {
      data: { content?: unknown; components: unknown[]; flags: number }
    }

    expect(callback.data.content ?? '').toBe('')
    expect(callback.data.flags & MessageFlags.IsComponentsV2).toBeTruthy()
    expect(JSON.stringify(callback.data.components)).toContain('attachment type is unsupported')
    expect(streamMock).not.toHaveBeenCalled()
  })

  it('rejects attachments larger than 10 MiB before downloading', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const fetchMock = vi.spyOn(globalThis, 'fetch')
    const calls = await dispatch(
      agentCommandJSON('inspect', {}, undefined, {
        attachment: {
          name: 'large.pdf',
          size: 10 * 1024 * 1024 + 1,
          contentType: 'application/pdf'
        }
      }),
      subs
    )

    expect(fetchMock).not.toHaveBeenCalled()
    expect(JSON.stringify(getCallback(calls))).toContain('attachment exceeds the 10 MiB limit')
    expect(streamMock).not.toHaveBeenCalled()
  })

  it('rejects attachment downloads whose type does not match Discord metadata', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const file = new TextEncoder().encode('not a png')
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(file, { headers: { 'content-type': 'text/plain' } })
    )

    const calls = await dispatch(
      agentCommandJSON('inspect', {}, undefined, {
        attachment: { name: 'photo.png', size: file.byteLength, contentType: 'image/png' }
      }),
      subs
    )

    expect(JSON.stringify(getCallback(calls))).toContain('attachment type is unsupported')
    expect(streamMock).not.toHaveBeenCalled()
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
    expect(JSON.stringify(calls)).not.toContain('**Reasoning**')
    expect(JSON.stringify(calls)).not.toContain('I should look this up.')
    expect(JSON.stringify(calls)).not.toContain('**Tools used**')
    expect(JSON.stringify(calls)).toContain('(docker_listx1, web_searchx1)')
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
        clientConfig: { baseURL: 'https://api.openai.com/v1', maxRetries: 0 },
        modelId: 'gpt-5.4',
        params: {
          parallel_tool_calls: true,
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
      args: [expect.stringMatching(/server-filesystem\/dist\/index\.js$/), '/']
    })
    expect(transportMock).toHaveBeenCalledWith({
      command: process.execPath,
      args: [expect.stringMatching(/server-memory\/dist\/index\.js$/)],
      env: { MEMORY_FILE_PATH: getAgentMemoryPath() }
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
        retryStrategy: null,
        toolExecutor: 'concurrent',
        tools: [
          expect.objectContaining({ name: 'shell' }),
          expect.objectContaining({ name: 'wait' }),
          expect.objectContaining({ name: 'publish_html' }),
          expect.objectContaining({ name: 'spotify_authenticate' }),
          expect.objectContaining({ name: 'google_calendar_authenticate' }),
          expect.objectContaining({ name: 'manage_discord_features' }),
          expect.objectContaining({ name: 'manage_mcp_servers' }),
          expect.objectContaining({ name: 'load_mcp_tools' }),
          expect.objectContaining({ name: 'delegate_tasks' }),
          expect.objectContaining({ name: 'manage_response_modals' }),
          ...Array(7).fill(expect.anything())
        ]
      })
    )
    expect(disconnectMock).not.toHaveBeenCalled()
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

  it('keeps native tools available while offering MCP discovery without loading MCP tools', async () => {
    mcpActions.push({ action: 'list' })
    await dispatch(agentCommandJSON('answer directly', {}, undefined, { tools: null }), subs)
    await dispatch(agentCommandJSON('continue directly', {}, undefined, { tools: null }), subs)

    expect(mcpActionResults).toContain('No persistent MCP servers are attached.')
    for (const [options] of modelMock.mock.calls) {
      expect(options).toEqual(
        expect.objectContaining({
          params: { reasoning: { effort: 'medium', summary: 'auto' } }
        })
      )
    }
    for (const [options] of agentMock.mock.calls) {
      expect(options).toEqual(
        expect.objectContaining({
          systemPrompt: expect.stringContaining('Available MCP servers and capabilities:'),
          tools: [
            expect.objectContaining({ name: 'shell' }),
            expect.objectContaining({ name: 'wait' }),
            expect.objectContaining({ name: 'publish_html' }),
            expect.objectContaining({ name: 'spotify_authenticate' }),
            expect.objectContaining({ name: 'google_calendar_authenticate' }),
            expect.objectContaining({ name: 'manage_discord_features' }),
            expect.objectContaining({ name: 'manage_mcp_servers' }),
            expect.objectContaining({ name: 'load_mcp_tools' }),
            expect.objectContaining({ name: 'delegate_tasks' }),
            expect.objectContaining({ name: 'manage_response_modals' })
          ]
        })
      )
      expect(options.systemPrompt).toContain('docker')
      expect(options.systemPrompt).toContain('inspect and manage Docker containers')
      expect(options.systemPrompt).toContain(
        'filesystem (read, search, create, and modify local files)'
      )
      expect(options.systemPrompt).toContain(
        'Before answering, decide whether the request depends on'
      )
      expect(options.systemPrompt).toContain('use load_mcp_tools and then the loaded tools')
      expect(options.systemPrompt).toContain(
        'Use manage_mcp_servers to list, attach, replace, remove'
      )
      expect(options.tools.some(({ name }: { name: string }) => name.startsWith('docker_'))).toBe(
        false
      )
    }
  })

  it('delegates bounded independent tasks to fresh agent copies in parallel', async () => {
    await dispatch(agentCommandJSON('handle a complex request'), subs)
    const delegate = registeredAgentTools.get('delegate_tasks') as {
      callback: (input: { tasks: Array<{ task: string }> }) => Promise<string>
    }

    const result = JSON.parse(
      await delegate.callback({ tasks: [{ task: 'inspect API' }, { task: 'inspect tests' }] })
    ) as Array<{ status: string; result: string }>

    expect(subagentInvokeMock).toHaveBeenCalledTimes(2)
    expect(subagentInvokeMock).toHaveBeenCalledWith(
      'inspect API',
      expect.objectContaining({
        cancelSignal: expect.any(AbortSignal),
        limits: { turns: 8, totalTokens: 4096 }
      })
    )
    expect(subagentInvokeMock).toHaveBeenCalledWith('inspect tests', expect.anything())
    expect(result).toEqual([
      { task: 1, status: 'success', result: 'finding: inspect API' },
      { task: 2, status: 'success', result: 'finding: inspect tests' }
    ])

    const childOptions = agentMock.mock.calls.slice(-2).map(([options]) => options)
    expect(childOptions).toEqual(
      Array(2).fill(
        expect.objectContaining({
          systemPrompt: expect.stringContaining('delegated copy of the primary agent'),
          tools: expect.not.arrayContaining([expect.objectContaining({ name: 'delegate_tasks' })]),
          toolExecutor: 'concurrent'
        })
      )
    )
    expect(String(childOptions[0].systemPrompt)).toContain('return concise plain-text findings')
    expect(String(childOptions[0].systemPrompt)).not.toContain(
      'Return the complete user-visible Discord message'
    )
  })

  it('lets the agent discover and load selected MCP tools on demand', async () => {
    mcpToolGroups.push(
      [{ name: 'list_containers', description: 'List Docker containers' }],
      [{ name: 'read_file', description: 'Read a file' }],
      ...Array.from({ length: 5 }, (_, index) => [{ name: `other_${index}` }])
    )
    await dispatch(agentCommandJSON('inspect containers', {}, undefined, { tools: null }), subs)

    const loader = registeredAgentTools.get('load_mcp_tools') as {
      callback: (input: { action: 'list' | 'load'; servers?: string[] }) => Promise<string>
    }
    const catalog = JSON.parse(await loader.callback({ action: 'list' })) as {
      servers: Array<{ name: string; tools: Array<{ name: string }> }>
    }
    expect(catalog.servers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: 'docker',
          tools: [expect.objectContaining({ name: 'docker_list_containers' })]
        }),
        expect.objectContaining({
          name: 'filesystem',
          tools: [expect.objectContaining({ name: 'filesystem_read_file' })]
        })
      ])
    )

    await expect(loader.callback({ action: 'load', servers: ['docker'] })).resolves.toBe(
      'Loaded 1 MCP tool from docker: docker_list_containers.'
    )
    expect(toolRegistryAddMock).toHaveBeenLastCalledWith([
      expect.objectContaining({ name: 'docker_list_containers' })
    ])
  })

  it('posts a separate completion message when the response takes at least 30 seconds', async () => {
    let now = 1_000_000
    vi.spyOn(Date, 'now').mockImplementation(() => now)
    streamMock.mockImplementationOnce(() => {
      now += 30_000
    })

    const calls = await dispatch(agentCommandJSON('slow request'), subs)
    const completion = calls.find(
      (call) => call.method === 'POST' && call.route.includes('/webhooks/')
    )

    expect(completion?.body).toMatchObject({
      content: '완료되었습니다.',
      allowed_mentions: { parse: [] }
    })
  })

  it('does not post a completion message for a response under 30 seconds', async () => {
    const calls = await dispatch(agentCommandJSON('quick request'), subs)

    expect(calls.some((call) => call.method === 'POST' && call.route.includes('/webhooks/'))).toBe(
      false
    )
  })

  it('reports detailed lifecycle timing only when debug mode is enabled', async () => {
    const normalCalls = await dispatch(agentCommandJSON('normal request'), subs)
    const debugCalls = await dispatch(
      agentCommandJSON('debug request', {}, undefined, { debug: true }),
      subs
    )
    const report = debugCalls.find(
      (call) => call.method === 'POST' && JSON.stringify(call.body).includes('Debug timing')
    )

    expect(JSON.stringify(normalCalls)).not.toContain('Debug timing')
    expect(JSON.stringify(report?.body)).toContain('Discord acknowledgement')
    expect(JSON.stringify(report?.body)).toContain('session queue wait')
    expect(JSON.stringify(report?.body)).toContain('OpenAI request started')
    expect(JSON.stringify(report?.body)).toContain('OpenAI response.created received')
    expect(JSON.stringify(report?.body)).toContain('first reasoning token received')
    expect(JSON.stringify(report?.body)).toContain('first function call received')
    expect(JSON.stringify(report?.body)).toContain('first web search result received')
    expect(JSON.stringify(report?.body)).toContain('first response token received')
    expect(JSON.stringify(report?.body)).toContain('final response delivery')
    expect(JSON.stringify(report?.body)).toContain('total to timing report')
  })

  it('reuses MCP clients across agent turns', async () => {
    await dispatch(agentCommandJSON('first request'), subs)
    expect(mcpClientMock).toHaveBeenCalledTimes(7)

    await dispatch(agentCommandJSON('second request'), subs)

    expect(mcpClientMock).toHaveBeenCalledTimes(7)
    expect(disconnectMock).not.toHaveBeenCalled()
  })

  it('provides a bounded wait tool', async () => {
    await dispatch(agentCommandJSON('wait briefly'), subs)
    const wait = registeredAgentTools.get('wait') as {
      callback: (input: { seconds: number }) => Promise<string>
    }

    await expect(wait.callback({ seconds: 0.1 })).resolves.toBe('Waited 0.1 seconds.')
  })

  it('shows compact tool counts without reasoning while the agent is generating', async () => {
    const calls = await dispatch(agentCommandJSON('inspect the system'), subs)
    const progressEdits = calls
      .filter((call) => call.method === 'PATCH')
      .slice(0, -1)
      .map((call) => JSON.stringify(call.body))

    expect(progressEdits.every((edit) => !edit.includes('I should look this up.'))).toBe(true)
    expect(progressEdits.some((edit) => edit.includes('(docker_listx1)'))).toBe(true)
    expect(progressEdits.every((edit) => !edit.includes('running'))).toBe(true)
    expect(progressEdits.every((edit) => !edit.includes('success'))).toBe(true)
    expect(progressEdits.every((edit) => edit.includes('generating...'))).toBe(true)
    expect(progressEdits.every((edit) => edit.includes('**inspect the system**'))).toBe(true)
    expect(progressEdits.every((edit) => edit.includes('"type":14'))).toBe(true)
    expect(progressEdits.every((edit) => edit.includes('"flags":32768'))).toBe(true)
    expect(progressEdits.every((edit) => !edit.includes('secret'))).toBe(true)
  })

  it('streams Components V2 text without populating message content', async () => {
    const calls = await dispatch(agentCommandJSON('answer now'), subs)
    const progressEdits = calls
      .filter((call) => call.method === 'PATCH')
      .slice(0, -1)
      .map((call) => call.body as { content?: unknown; flags?: number; components?: unknown[] })

    expect(progressEdits.every((edit) => edit.content === null || edit.content === '')).toBe(true)
    expect(progressEdits.every((edit) => edit.flags === MessageFlags.IsComponentsV2)).toBe(true)
    expect(
      progressEdits.some((edit) => JSON.stringify(edit.components).includes('hello world'))
    ).toBe(true)
  })

  it('aggregates repeated tool uses without exposing reasoning or statuses', async () => {
    streamMock.mockReturnValueOnce('multipleActivity')

    const calls = await dispatch(agentCommandJSON('research this'), subs)
    const progressEdits = calls
      .filter((call) => call.method === 'PATCH')
      .slice(0, -1)
      .map((call) => JSON.stringify(call.body))
    const compactEdit = progressEdits.find((edit) => edit.includes('searchx3'))!

    expect(compactEdit).toContain('(docker_listx1, web_searchx1, searchx3)')
    expect(progressEdits.every((edit) => !edit.includes('**Reasoning**'))).toBe(true)
    expect(progressEdits.every((edit) => !edit.includes('Earlier reasoning.'))).toBe(true)
    expect(progressEdits.every((edit) => !edit.includes('Latest reasoning.'))).toBe(true)
    expect(progressEdits.every((edit) => !edit.includes(': success'))).toBe(true)
  })

  it('renders a valid fallback when the agent emits no response text', async () => {
    streamMock.mockReturnValueOnce('noResponse')

    const calls = await dispatch(agentCommandJSON('do the work'), subs)
    const finalEdit = calls.filter((call) => call.method === 'PATCH').at(-1)?.body

    expect(JSON.stringify(finalEdit)).toContain('(no response)')
    expect(JSON.stringify(finalEdit)).not.toContain('Unexpected token')
    expect(getStoredValue('gpt-session:default')).toContain('(no response)')
  })

  it('asks the agent to repair malformed tool input once', async () => {
    streamMock.mockReturnValueOnce(new Error('unable to parse tool input JSON'))

    const calls = await dispatch(agentCommandJSON('inspect the system'), subs)

    expect(agentMock).toHaveBeenCalledTimes(1)
    expect(streamMock).toHaveBeenCalledTimes(2)
    expect(streamMock.mock.calls[1]?.[0]).toContain('Make one bounded recovery attempt')
    expect(streamMock.mock.calls[1]?.[0]).toContain('unable to parse tool input JSON')
    expect(JSON.stringify(calls)).toContain('hello world')
  })

  it('asks the agent to repair a general tool-use error once', async () => {
    streamMock.mockReturnValueOnce(new Error('tool execution failed'))

    const calls = await dispatch(agentCommandJSON('inspect the system'), subs)

    expect(agentMock).toHaveBeenCalledTimes(1)
    expect(streamMock).toHaveBeenCalledTimes(2)
    expect(streamMock.mock.calls[1]?.[0]).toContain('tool execution failed')
    expect(JSON.stringify(calls)).toContain('hello world')
  })

  it('stops after one failed recovery attempt and renders a safe fallback', async () => {
    streamMock
      .mockReturnValueOnce(new Error('tool execution failed'))
      .mockReturnValueOnce(new Error('repair also failed'))
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.spyOn(console, 'error').mockImplementation(() => {})

    const calls = await dispatch(agentCommandJSON('inspect the system'), subs)

    expect(streamMock).toHaveBeenCalledTimes(2)
    expect(JSON.stringify(calls)).toContain('error: repair also failed')
  })

  it('uses bounded recovery for an incomplete stream after tool activity', async () => {
    streamMock.mockReturnValueOnce('streamIncompleteAfterActivity')
    vi.spyOn(console, 'error').mockImplementation(() => {})

    const calls = await dispatch(agentCommandJSON('inspect the system'), subs)

    expect(agentMock).toHaveBeenCalledTimes(2)
    expect(streamMock).toHaveBeenCalledTimes(2)
    expect(streamMock.mock.calls[1]?.[0]).toContain(
      '502 Upstream websocket closed before response.completed'
    )
    expect(agentMock.mock.calls[1]?.[0]).not.toHaveProperty('modelState')
    expect(JSON.stringify(calls)).toContain('hello world')
  })

  it('retries malformed response JSON with the original request, previous output, and error', async () => {
    responsePayloads.push('not valid JSON', {
      components: [{ type: 10, content: 'repaired response' }],
      flags: MessageFlags.IsComponentsV2
    })
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {})

    const calls = await dispatch(agentCommandJSON('show status'), subs)

    expect(agentMock).toHaveBeenCalledTimes(1)
    expect(streamMock).toHaveBeenCalledTimes(2)
    expect(JSON.stringify(calls)).toContain('repaired response')
    expect(streamMock.mock.calls[1]?.[0]).toContain('Original request: "show status"')
    expect(streamMock.mock.calls[1]?.[0]).toContain('Previous output: "not valid JSON"')
    expect(streamMock.mock.calls[1]?.[0]).toContain('validation error:')
    expect(warning).toHaveBeenCalledWith(expect.stringContaining('validation failed'))
  })

  it('stops correcting after the bounded retry limit and renders a final error', async () => {
    responsePayloads.push('bad one', 'bad two', 'bad three')
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {})

    const calls = await dispatch(agentCommandJSON('show status'), subs)

    expect(streamMock).toHaveBeenCalledTimes(3)
    expect(JSON.stringify(calls)).toContain('Agent response validation failed after 3 attempts')
    expect(errorLog).toHaveBeenCalledWith('Agent response failed', expect.any(Error))
  })

  it('retains compact tool counts while recovering from tool input failure', async () => {
    streamMock.mockReturnValueOnce('throwAfterActivity')

    const calls = await dispatch(agentCommandJSON('inspect the system'), subs)
    const finalEdit = calls.filter((call) => call.method === 'PATCH').at(-1)?.body
    const rendered = JSON.stringify(finalEdit)

    expect(agentMock).toHaveBeenCalledTimes(1)
    expect(rendered).toContain('hello world')
    expect(rendered).not.toContain('I should look this up.')
    expect(rendered).toContain('(docker_listx2, web_searchx1)')
    expect(rendered).not.toContain(': error')
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
      clientConfig: { baseURL: 'https://inference.example.com/openai/v1', maxRetries: 0 }
    })
    expect(modelMock.mock.calls[1]?.[0]).toMatchObject({
      clientConfig: { baseURL: 'https://inference.example.com/openai/v1', maxRetries: 0 }
    })

    await dispatch(
      agentCommandJSON('restore OpenAI', {}, 'work', { resetOpenAIEndpoint: true }),
      subs
    )
    expect(modelMock.mock.calls[2]?.[0]).toMatchObject({
      clientConfig: { baseURL: 'https://api.openai.com/v1', maxRetries: 0 }
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

  it('corrects populated content into raw Components V2 output', async () => {
    responsePayloads.push(
      '{"content":"legacy response","components":[{"type":10,"content":"status"}],"flags":32768}',
      {
        components: [{ type: 10, content: 'Everything is healthy' }],
        flags: MessageFlags.IsComponentsV2,
        allowed_mentions: { parse: [] }
      }
    )
    vi.spyOn(console, 'warn').mockImplementation(() => {})

    const calls = await dispatch(agentCommandJSON('show status'), subs)
    const edit = calls.filter((call) => call.method === 'PATCH').at(-1)?.body as {
      content?: string | null
      components: Array<{ content?: string }>
      flags: number
      allowed_mentions?: unknown
    }

    expect(edit.content).toBe('')
    expect(edit.flags).toBe(MessageFlags.IsComponentsV2)
    expect(JSON.stringify(edit.components)).toContain('Everything is healthy')
    expect(JSON.stringify(edit.components)).not.toContain('legacy response')
    expect(edit.allowed_mentions).toEqual({ parse: [] })
    expect(streamMock.mock.calls[1]?.[0]).toContain(
      'content field must be omitted or null for Components V2 responses'
    )
  })

  it('corrects a response that omits the Components V2 flag', async () => {
    responsePayloads.push(
      { components: [{ type: 10, content: 'Missing flag' }] },
      {
        components: [{ type: 10, content: 'Flag repaired' }],
        flags: MessageFlags.IsComponentsV2
      }
    )
    vi.spyOn(console, 'warn').mockImplementation(() => {})

    const calls = await dispatch(agentCommandJSON('show status'), subs)

    expect(streamMock).toHaveBeenCalledTimes(2)
    expect(JSON.stringify(calls.at(-1)?.body)).toContain('Flag repaired')
    expect(streamMock.mock.calls[1]?.[0]).toContain(
      'Components V2 responses must set the flags field to include 32768'
    )
  })

  it('renders raw Components V2 after the request prompt and a divider', async () => {
    responsePayloads.push({
      components: [
        { type: 10, content: 'Rendered response' },
        { type: 10, content: 'Additional context' }
      ],
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
    expect(edit.components.at(-2)?.content).toContain('(docker_listx1, web_searchx1)')
    expect(edit.components.at(-2)?.content).not.toContain('**Reasoning**')
  })

  it('accepts the maximum text-display length', async () => {
    responsePayloads.push({
      components: [{ type: 10, content: `${'x'.repeat(3987)}latest result` }],
      flags: MessageFlags.IsComponentsV2
    })

    const calls = await dispatch(agentCommandJSON('show the result'), subs)
    const edit = calls.filter((call) => call.method === 'PATCH').at(-1)?.body as {
      components: Array<{ type: number; content?: string }>
    }
    const response = edit.components[2]?.content ?? ''

    expect(response).toHaveLength(4000)
    expect(response.endsWith('latest result')).toBe(true)
  })

  it('retries a Discord API rejection with concrete details', async () => {
    responsePayloads.push(
      {
        components: [{ type: 10, content: 'First response' }],
        flags: MessageFlags.IsComponentsV2
      },
      {
        components: [{ type: 10, content: 'Corrected response' }],
        flags: MessageFlags.IsComponentsV2
      }
    )
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    let rejected = false

    const calls = await dispatch(agentCommandJSON('show deployment'), subs, {
      patchError: (body) => {
        const serialized = JSON.stringify(body)
        if (
          rejected ||
          serialized.includes('generating...') ||
          !serialized.includes('First response')
        ) {
          return undefined
        }
        rejected = true
        return Object.assign(new Error('Invalid Form Body'), {
          code: 50035,
          status: 400,
          rawError: {
            code: 50035,
            message: 'Invalid Form Body',
            errors: { components: { _errors: [{ message: 'Component is invalid' }] } }
          },
          url: 'https://discord.example/webhooks/secret-token'
        })
      }
    })

    expect(streamMock).toHaveBeenCalledTimes(2)
    expect(JSON.stringify(calls.at(-1)?.body)).toContain('Corrected response')
    expect(streamMock.mock.calls[1]?.[0]).toContain('Original request: "show deployment"')
    expect(streamMock.mock.calls[1]?.[0]).toContain('Previous output:')
    expect(streamMock.mock.calls[1]?.[0]).toContain('Discord API error: Invalid Form Body')
    expect(streamMock.mock.calls[1]?.[0]).toContain('Component is invalid')
    expect(streamMock.mock.calls[1]?.[0]).not.toContain('secret-token')
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
        tools: [expect.anything(), ...Array(17).fill(expect.anything())]
      })
    )
    expect(disconnectMock).not.toHaveBeenCalled()
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
        tools: [expect.anything(), ...Array(17).fill(expect.anything())]
      })
    )
    expect(disconnectMock).not.toHaveBeenCalled()
  })

  it('keeps the agent available when Mail MCP authentication fails', async () => {
    process.env.MAIL_API_KEY = 'invalid-key'
    mcpToolFailures.push(false, false, false, false, false, false, false, true)

    const calls = await dispatch(agentCommandJSON('update my mail API key'), subs)

    expect(agentMock).toHaveBeenCalledWith(
      expect.objectContaining({
        tools: [expect.anything(), ...Array(16).fill(expect.anything())]
      })
    )
    expect(JSON.stringify(calls)).toContain('hello world')
    expect(JSON.stringify(calls)).not.toContain('MCP authentication failed')
    expect(agentMock).toHaveBeenCalledWith(
      expect.objectContaining({
        systemPrompt: expect.stringContaining(
          'mail: MCP authentication failed. Diagnose and repair each failure'
        )
      })
    )
    expect(disconnectMock).toHaveBeenCalledTimes(1)
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
    expect(disconnectMock).not.toHaveBeenCalled()
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

  it('reports a failed MCP boot to the agent for repair', async () => {
    mcpToolFailures.push(false, false, false, false, false, false, false, true)
    mcpActions.push({
      action: 'attach',
      name: 'github',
      transport: 'http',
      url: 'https://mcp.example.com/mcp'
    })

    await dispatch(agentCommandJSON('attach the GitHub MCP'), subs)

    expect(mcpActionResults.at(-1)).toBe(
      'Could not boot MCP server github: MCP authentication failed. Diagnose the configuration or runtime, correct it, and try attaching the server again.'
    )
    expect(getStoredValue('gpt-mcp-servers')).toBeUndefined()

    await dispatch(agentCommandJSON('repair the GitHub MCP'), subs)
    expect(agentMock).toHaveBeenLastCalledWith(
      expect.objectContaining({
        systemPrompt: expect.stringContaining(
          'github: MCP authentication failed. Diagnose and repair each failure'
        )
      })
    )
  })

  it('lets the agent restart the shared MCP runtime after a repair', async () => {
    process.env.MAIL_API_KEY = 'repaired-key'
    mcpToolFailures.push(false, false, false, false, false, false, false, true)
    mcpActions.push({ action: 'restart' })

    await dispatch(agentCommandJSON('repair and restart MCP'), subs)

    expect(mcpActionResults.at(-1)).toBe('Restarted MCP servers successfully with 8 tools.')
    expect(mcpClientMock).toHaveBeenCalledTimes(16)
    expect(disconnectMock).toHaveBeenCalledTimes(8)
    expect(toolRegistryAddMock).toHaveBeenCalledWith(
      expect.arrayContaining([expect.objectContaining({ name: 'mail_mcp_tool_15' })])
    )
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
    expect(tools).toHaveLength(17)
  })

  it('asks the agent to recover a closed MCP connection once', async () => {
    streamMock.mockReturnValueOnce(new Error('MCP error -32000: Connection closed'))

    const calls = await dispatch(agentCommandJSON('list my containers'), subs)

    expect(agentMock).toHaveBeenCalledTimes(1)
    expect(streamMock).toHaveBeenCalledTimes(2)
    expect(streamMock.mock.calls[1]?.[0]).toContain('MCP error -32000: Connection closed')
    expect(JSON.stringify(calls)).toContain('hello world')
    expect(disconnectMock).not.toHaveBeenCalled()
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
          parallel_tool_calls: true,
          reasoning: { effort: 'high', summary: 'auto' },
          tools: [{ type: 'web_search' }]
        }
      })
    )
  })

  it('explicitly disables reasoning when effort is none', async () => {
    await dispatch(
      agentCommandJSON('answer quickly', {}, 'fast', {
        model: 'gpt-5.6-sol',
        effort: 'none'
      }),
      subs
    )

    expect(modelMock).toHaveBeenCalledWith(
      expect.objectContaining({
        modelId: 'gpt-5.6-sol',
        params: {
          parallel_tool_calls: true,
          reasoning: { effort: 'none' },
          tools: [{ type: 'web_search' }]
        }
      })
    )
  })

  it('omits sequential-thinking tools when effort is none', async () => {
    mcpToolGroups.push(
      [{ name: 'docker_tool' }],
      [{ name: 'filesystem_tool' }],
      [{ name: 'memory_tool' }],
      [{ name: 'think' }],
      [{ name: 'fetch_tool' }],
      [{ name: 'time_tool' }],
      [{ name: 'playwright_tool' }]
    )

    await dispatch(agentCommandJSON('answer quickly', {}, 'fast', { effort: 'none' }), subs)

    const tools = (agentMock.mock.calls[0]![0] as { tools: Array<{ name: string }> }).tools
    expect(tools.some(({ name }) => name.startsWith('sequential_thinking_'))).toBe(false)
    expect(tools).toContainEqual(expect.objectContaining({ name: 'filesystem_filesystem_tool' }))
    expect(tools).toContainEqual(expect.objectContaining({ name: 'manage_mcp_servers' }))
    expect(tools).toContainEqual(expect.objectContaining({ name: 'load_mcp_tools' }))
  })

  it('continues a session with the previous Responses API id', async () => {
    responseIds.push('response-one', 'response-two')

    await dispatch(agentCommandJSON('first question'), subs)
    await dispatch(agentCommandJSON('follow up'), subs)

    expect(modelMock).toHaveBeenCalledWith(expect.objectContaining({ stateful: true }))
    expect(agentMock.mock.calls[1]?.[0]).toMatchObject({
      messages: [],
      modelState: { responseId: 'response-one' }
    })
    const middlewareResult = (await modelMiddlewareHandlers[0]?.({
      messages: [
        { role: 'user', content: 'question' },
        { role: 'assistant', content: 'tool call' },
        { role: 'user', content: 'tool result' }
      ]
    } as never)) as { messages: Array<{ content: string }> }
    expect(middlewareResult.messages).toEqual([{ role: 'user', content: 'tool result' }])
    expect(getStoredValue('gpt-session:default')).toContain('response-two')
  })

  it('recovers stale Responses API state after an incomplete upstream stream', async () => {
    responseIds.push('response-one')
    await dispatch(agentCommandJSON('first question'), subs)
    const cause = Object.assign(
      new Error('502 Upstream websocket closed before response.completed'),
      { status: 502, code: 'stream_incomplete' }
    )
    streamMock.mockReturnValueOnce(
      new Error('502 Upstream websocket closed before response.completed', { cause })
    )
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {})

    const calls = await dispatch(agentCommandJSON('follow up'), subs)

    expect(streamMock).toHaveBeenCalledTimes(3)
    expect(agentMock.mock.calls[1]?.[0]).toMatchObject({
      messages: [],
      modelState: { responseId: 'response-one' }
    })
    const retryOptions = agentMock.mock.calls[2]?.[0] as {
      messages: unknown[]
      modelState?: unknown
    }
    expect(retryOptions).not.toHaveProperty('modelState')
    expect(retryOptions.messages).toEqual([
      { role: 'user', content: [{ text: 'first question' }] },
      {
        role: 'assistant',
        content: [
          {
            text: '{"components":[{"type":10,"content":"hello world"}],"flags":32768}'
          }
        ]
      }
    ])
    expect(JSON.stringify(calls)).toContain('hello world')
    expect(JSON.stringify(calls)).not.toContain('Upstream websocket closed')
    expect(warning).toHaveBeenCalledWith(expect.stringContaining('without stale response state'))
  })

  it('rebuilds local history when the model changes', async () => {
    responseIds.push('response-one')
    await dispatch(agentCommandJSON('first question'), subs)

    await dispatch(
      agentCommandJSON('use another model', {}, 'default', { model: 'gpt-5.6-sol' }),
      subs
    )

    expect(agentMock.mock.calls[1]?.[0]).toMatchObject({
      messages: [
        { role: 'user', content: [{ text: 'first question' }] },
        {
          role: 'assistant',
          content: [
            {
              text: '{"components":[{"type":10,"content":"hello world"}],"flags":32768}'
            }
          ]
        }
      ]
    })
  })

  it('creates and lists web sessions with their persisted settings', async () => {
    const created = createWebSession('web-user', 'project notes')

    expect(created).toEqual({
      sessions: ['default', 'project notes'],
      selectedSession: 'project notes',
      settings: {
        model: 'gpt-5.4',
        effort: 'medium',
        maxTokens: 4096,
        toolsEnabled: false
      }
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
      settings: {
        model: 'gpt-5.4-mini',
        effort: 'high',
        maxTokens: 2048,
        toolsEnabled: false
      }
    })
    expect(() => createWebSession('web-user', ' ')).toThrow('Session name must not be empty')
  })

  it('streams Components V2 text through web updates before the final payload', async () => {
    responsePayloads.push({
      components: [{ type: 10, content: 'streaming through the web UI' }],
      flags: MessageFlags.IsComponentsV2
    })
    const updates: unknown[] = []

    await runWebAgent({ userId: 'web-user', prompt: 'stream this' }, async (payload) => {
      updates.push(payload)
    })

    expect(
      updates
        .slice(0, -1)
        .some((payload) => JSON.stringify(payload).includes('streaming through the web UI'))
    ).toBe(true)
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
      expect(active.at(-1)?.content).toContain('generating...')
      expect(active.at(-1)?.content).not.toContain('Working through the request.')
    })

    await expect(cancelWebAgent('web-user', 'work', 'run-one')).resolves.toBe(true)
    await running

    expect(loadWebConversation('web-user', 'work')).toEqual([
      { role: 'user', content: 'long request' },
      expect.objectContaining({
        role: 'assistant',
        status: 'cancelled',
        content: expect.stringContaining('cancelled')
      })
    ])
    expect(JSON.stringify(updates.at(-1))).toContain('cancelled')
  })

  it('interrupts an active wait when the web request is cancelled', async () => {
    streamMock.mockReturnValueOnce('waitInTool')
    const running = runWebAgent(
      {
        userId: 'web-user',
        prompt: 'wait for deployment',
        runId: 'waiting-run',
        toolsEnabled: true
      },
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
          content: expect.stringContaining('generating...')
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
            content: [{ text: expect.stringContaining('{"components":') }]
          })
        ])
      })
    )
    const rewritten = clickCalls.filter((call) => call.method === 'PATCH').at(-1)?.body
    expect(JSON.stringify(rewritten)).toContain('hello world')
    expect(JSON.stringify(rewritten)).not.toContain(GPT_ACTION_COMPONENT_ID)
  })

  it('restricts sender-only components while allowing administrators', async () => {
    process.env.ADMIN_USER_IDS = '666666666666666666,777777777777777777'
    responsePayloads.push({
      components: [
        { type: 10, content: 'Choose an action' },
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
      ],
      flags: MessageFlags.IsComponentsV2
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

    const adminCalls = await dispatch(
      buttonJSON(initialEdit.components, actionId!, {
        user: {
          id: '777777777777777777',
          username: 'adminuser',
          discriminator: '0',
          avatar: null,
          global_name: 'Admin User'
        }
      }),
      subs
    )
    expect(getCallback(adminCalls)).toMatchObject({
      type: InteractionResponseType.DeferredMessageUpdate
    })
    expect(streamMock).toHaveBeenCalledTimes(2)
  })

  it('persists web button payloads and routes custom-id clicks through the agent interaction flow', async () => {
    responsePayloads.push({
      components: [
        { type: 10, content: 'Choose an action' },
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
      ],
      flags: MessageFlags.IsComponentsV2
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

    responsePayloads.push({
      components: [{ type: 10, content: 'Continued from the button' }],
      flags: MessageFlags.IsComponentsV2
    })
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
      components: [
        { type: 10, content: 'Choose settings' },
        {
          type: 1,
          components: [{ type: 2, custom_id: 'configure', label: 'Configure', style: 1 }]
        }
      ],
      flags: MessageFlags.IsComponentsV2
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
    await runWebAgent(
      { userId: 'web-owner', prompt: 'build controls', toolsEnabled: true },
      async (payload) => {
        updates.push(payload)
      }
    )
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
      responsePayloads.push({
        components: [{ type: 10, content: 'updated' }, ...webComponents],
        flags: MessageFlags.IsComponentsV2
      })
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
      components: [
        { type: 10, content: 'Choose settings' },
        {
          type: 1,
          components: [{ type: 2, custom_id: 'configure', label: 'Configure', style: 1 }]
        }
      ],
      flags: MessageFlags.IsComponentsV2
    })
    const updates: unknown[] = []
    await runWebAgent(
      { userId: 'web-owner', prompt: 'configure', toolsEnabled: true },
      async (payload) => {
        updates.push(payload)
      }
    )
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

    responsePayloads.push({
      components: [{ type: 10, content: 'configured' }],
      flags: MessageFlags.IsComponentsV2
    })
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
      ],
      flags: MessageFlags.IsComponentsV2
    })
    const updates: unknown[] = []
    await runWebAgent(
      { userId: 'web-owner', prompt: 'preferences', toolsEnabled: true },
      async (payload) => {
        updates.push(payload)
      }
    )
    const actionId = JSON.stringify(updates.at(-1)).match(/gpt-action:[^"\\]+:preferences/)?.[0]
    const opened = await runWebInteraction(
      { userId: 'web-owner', customId: actionId! },
      async () => {}
    )
    const modalId = 'modal' in opened ? String(opened.modal.custom_id) : ''

    responsePayloads.push({
      components: [{ type: 10, content: 'saved' }],
      flags: MessageFlags.IsComponentsV2
    })
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
      components: [
        { type: 10, content: 'Private action' },
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
      ],
      flags: MessageFlags.IsComponentsV2
    })
    const updates: unknown[] = []
    await runWebAgent({ userId: 'web-owner', prompt: 'private control' }, async (payload) => {
      updates.push(payload)
    })
    const customId = JSON.stringify(updates.at(-1)).match(/gpt-action:[^"\\]+:private-action/)?.[0]

    responsePayloads.push({
      components: [{ type: 10, content: 'Private action completed' }],
      flags: MessageFlags.IsComponentsV2
    })
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
      ],
      flags: MessageFlags.IsComponentsV2
    })
    const updates: unknown[] = []
    await runWebAgent(
      { userId: 'web-owner', prompt: 'upload', toolsEnabled: true },
      async (payload) => {
        updates.push(payload)
      }
    )
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

  it('cancels an overlapping request in the same session', async () => {
    await Promise.all([
      dispatch(agentCommandJSON('first concurrent question'), subs),
      dispatch(agentCommandJSON('second concurrent question'), subs)
    ])

    expect(agentMock).toHaveBeenCalledTimes(1)
    expect(streamMock).toHaveBeenCalledWith('second concurrent question', expect.anything())
  })

  it('cancels a running Discord request before starting its replacement', async () => {
    streamMock.mockReturnValueOnce('waitForAbort')
    const first = dispatch(agentCommandJSON('first long question'), subs)
    await vi.waitFor(() => expect(streamMock).toHaveBeenCalledTimes(1))

    const second = dispatch(agentCommandJSON('replacement question'), subs)
    const [firstCalls, secondCalls] = await Promise.all([first, second])

    expect(JSON.stringify(firstCalls)).toContain('cancelled')
    expect(JSON.stringify(secondCalls)).toContain('hello world')
    expect(streamMock).toHaveBeenNthCalledWith(2, 'replacement question', expect.anything())
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
