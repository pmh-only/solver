import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { InteractionResponseType, MessageFlags } from 'discord.js'
import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import { agentCommand } from '../application-commands.js'
import { GPT_ACTION_COMPONENT_ID, GPT_MODAL_ID } from '../commands/gpt.js'
import { clearStoredValues, getStoredValue } from '../helpers/kv-store.js'
import {
  agentCommandJSON,
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
  mcpClientMock,
  modelMock,
  componentActions,
  modalActions,
  responsePayloads,
  streamMock,
  toolMock,
  transportMock
} = vi.hoisted(() => ({
  agentMock: vi.fn(),
  disconnectMock: vi.fn().mockResolvedValue(undefined),
  httpTransportMock: vi.fn(),
  mcpClientMock: vi.fn(),
  modelMock: vi.fn(),
  componentActions: [] as Record<string, unknown>[],
  modalActions: [] as Record<string, unknown>[],
  responsePayloads: [] as Record<string, unknown>[],
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

    constructor(options: unknown) {
      mcpClientMock(options)
    }
  },
  Agent: class MockAgent {
    private options: { tools?: { name?: string; callback?: (input: never) => unknown }[] }

    constructor(options: unknown) {
      agentMock(options)
      this.options = options as typeof this.options
    }

    async *stream(prompt: string, options: unknown) {
      const streamResult = streamMock(prompt, options)
      if (streamResult instanceof Error) throw streamResult
      const componentAction = componentActions.shift()
      const modalAction = modalActions.shift()
      if (modalAction) {
        const modalTool = this.options.tools?.find(
          (candidate) => candidate.name === 'manage_response_modals'
        )
        modalTool?.callback?.(modalAction as never)
      }
      yield {
        type: 'modelStreamUpdateEvent',
        event: {
          type: 'modelContentBlockDeltaEvent',
          delta: { type: 'reasoningContentDelta', text: 'I should look this up.' }
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
      yield {
        type: 'modelStreamUpdateEvent',
        event: {
          type: 'modelContentBlockDeltaEvent',
          delta: { type: 'citationsDelta', citations: [], content: [] }
        }
      }
      const response = JSON.stringify(
        responsePayloads.shift() ?? {
          content: 'hello world',
          ...(typeof componentAction?.components_json === 'string'
            ? { components: JSON.parse(componentAction.components_json) }
            : {})
        }
      )
      for (const text of [response.slice(0, 10), response.slice(10)]) {
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
const googleCalendarTestDirectory = join(process.cwd(), '.tmp', 'gpt-google-calendar-test')
const previousKvStorePath = process.env.KV_STORE_PATH

beforeEach(() => {
  process.env.OPENAI_API_KEY = 'test-key'
  componentActions.length = 0
  modalActions.length = 0
  responsePayloads.length = 0
  clearStoredValues()
})

afterEach(async () => {
  delete process.env.OPENAI_API_KEY
  delete process.env.MAIL_API_KEY
  delete process.env.GOOGLE_OAUTH_CREDENTIALS_BASE64
  delete process.env.GOOGLE_CALENDAR_REDIRECT_URI
  delete process.env.SPOTIFY_CLIENT_ID
  if (previousKvStorePath === undefined) delete process.env.KV_STORE_PATH
  else process.env.KV_STORE_PATH = previousKvStorePath
  await rm(googleCalendarTestDirectory, { recursive: true, force: true })
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

  it('renders the agent JSON publicly and appends token usage', async () => {
    const calls = await dispatch(agentCommandJSON('explain recursion'), subs)
    const defer = getCallback(calls) as { type: number; data?: { flags?: number } }
    expect(defer.type).toBe(InteractionResponseType.DeferredChannelMessageWithSource)
    expect((defer.data?.flags ?? 0) & MessageFlags.Ephemeral).toBeFalsy()
    const edit = getEdit(calls)
    expect(edit).not.toBeNull()
    expect(JSON.stringify(calls)).toContain('hello world')
    expect(JSON.stringify(calls)).not.toContain('I should look this up.')
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
        modelId: 'gpt-5.4',
        params: {
          reasoning: { effort: 'medium' },
          tools: [{ type: 'web_search' }]
        }
      })
    )
    expect(transportMock).toHaveBeenCalledWith({ command: 'uvx', args: ['mcp-server-docker'] })
    expect(transportMock).toHaveBeenCalledWith({
      command: 'uvx',
      args: ['mcp-server-fetch==2026.7.10']
    })
    expect(transportMock).toHaveBeenCalledWith({
      command: 'uvx',
      args: ['mcp-server-time==2026.7.10']
    })
    expect(transportMock).toHaveBeenCalledWith({
      command: process.execPath,
      args: [
        expect.stringMatching(/server-filesystem\/dist\/index\.js$/),
        expect.stringMatching(/data$/)
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
          expect.objectContaining({ name: 'spotify_authenticate' }),
          expect.objectContaining({ name: 'google_calendar_authenticate' }),
          expect.objectContaining({ name: 'manage_response_modals' }),
          ...Array(7).fill(expect.anything())
        ]
      })
    )
    expect(disconnectMock).toHaveBeenCalledTimes(7)
    expect(streamMock).toHaveBeenCalledWith(
      'explain recursion',
      expect.objectContaining({ limits: { turns: 8, outputTokens: 4096 } })
    )
  })

  it('preserves raw Discord embeds and appends token usage to the last footer', async () => {
    responsePayloads.push({
      embeds: [{ title: 'Status', description: 'Everything is healthy', footer: { text: 'Live' } }],
      allowed_mentions: { parse: [] }
    })

    const calls = await dispatch(agentCommandJSON('show status'), subs)
    const edit = calls.filter((call) => call.method === 'PATCH').at(-1)?.body as {
      embeds: Array<{ footer?: { text?: string } }>
      components: unknown[]
      allowed_mentions?: unknown
    }

    expect(edit.embeds[0]?.footer?.text).toContain('Live\nTokens used:')
    expect(edit.components).toEqual([])
    expect(edit.allowed_mentions).toEqual({ parse: [] })
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
        tools: [expect.anything(), ...Array(10).fill(expect.anything())]
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
        tools: [expect.anything(), ...Array(10).fill(expect.anything())]
      })
    )
    expect(disconnectMock).toHaveBeenCalledTimes(8)
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

  it('automatically diagnoses a closed MCP connection without MCP tools', async () => {
    streamMock.mockReturnValueOnce(new Error('MCP error -32000: Connection closed'))

    const calls = await dispatch(agentCommandJSON('list my containers'), subs)

    expect(agentMock).toHaveBeenCalledTimes(2)
    expect(agentMock).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        systemPrompt: expect.stringContaining('Diagnose the reported MCP connection failure'),
        tools: [
          expect.objectContaining({ name: 'spotify_authenticate' }),
          expect.objectContaining({ name: 'google_calendar_authenticate' }),
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
        params: { reasoning: { effort: 'high' }, tools: [{ type: 'web_search' }] }
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
          expect.objectContaining({
            role: 'assistant',
            content: [{ text: '{"content":"hello world"}' }]
          })
        ]
      })
    )
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

  it('switches to a new session and keeps it selected', async () => {
    await dispatch(agentCommandJSON('default question'), subs)
    const switched = await dispatch(agentCommandJSON('work question', {}, 'work'), subs)
    const continued = await dispatch(agentCommandJSON('follow-up'), subs)

    expect(JSON.stringify(switched)).toContain('hello world')
    expect(JSON.stringify(continued)).toContain('hello world')
    expect(agentMock).toHaveBeenLastCalledWith(
      expect.objectContaining({
        messages: [
          expect.objectContaining({ role: 'user', content: [{ text: 'work question' }] }),
          expect.objectContaining({
            role: 'assistant',
            content: [{ text: '{"content":"hello world"}' }]
          })
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
          expect.objectContaining({
            role: 'assistant',
            content: [{ text: '{"content":"hello world"}' }]
          })
        ]
      })
    )
  })

  it('does not inject session metadata into agent-owned output', async () => {
    const calls = await dispatch(agentCommandJSON('question', {}, 'work\n# notes'), subs)

    expect(JSON.stringify(calls)).toContain('hello world')
    expect(JSON.stringify(calls)).not.toContain('Session:')
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
