import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ContainerBuilder,
  escapeMarkdown,
  MessageFlags,
  SeparatorBuilder,
  SeparatorSpacingSize,
  StringSelectMenuBuilder,
  StringSelectMenuOptionBuilder,
  TextDisplayBuilder
} from 'discord.js'
import type {
  ButtonInteraction,
  ChatInputCommandInteraction,
  StringSelectMenuInteraction
} from 'discord.js'
import { Agent, McpClient, tool, type MessageData } from '@strands-agents/sdk'
import type { Usage } from '@strands-agents/sdk'
import { OpenAIModel } from '@strands-agents/sdk/models/openai'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { z } from 'zod'
import { container, matchesInteractiveId, PIN_BUTTON_ID, PUB_BUTTON_ID } from '../components.js'
import { deleteStoredValue, getStoredValue, setStoredValue } from '../helpers/kv-store.js'
import {
  beginSpotifyAuthentication,
  getSpotifyMcpEnvironment,
  loadSpotifyConfiguration
} from '../spotify-auth.js'

export const GPT_MODEL_SELECT_ID = 'gpt-model'
export const GPT_EFFORT_SELECT_ID = 'gpt-effort'
export const GPT_VERBOSITY_SELECT_ID = 'gpt-verbosity'
export const GPT_ACTION_BUTTON_ID = 'gpt-action'
export const AGENT_COMMAND_NAME = 'a'

const GPT_COLOR = 0x10a37f
const PAGE_LIMIT = 3600
const EDIT_INTERVAL_MS = 750
const DEFAULT_MAX_TOKENS = 4096
const GPT_INTERACTION_TTL_MS = 7 * 24 * 60 * 60 * 1000
const SPOTIFY_MCP_PATH = fileURLToPath(
  new URL('../../node_modules/spotify-mcp/dist/index.js', import.meta.url)
)
const FILESYSTEM_MCP_PATH = fileURLToPath(
  new URL(
    '../../node_modules/@modelcontextprotocol/server-filesystem/dist/index.js',
    import.meta.url
  )
)
const MEMORY_MCP_PATH = fileURLToPath(
  new URL('../../node_modules/@modelcontextprotocol/server-memory/dist/index.js', import.meta.url)
)
const SEQUENTIAL_THINKING_MCP_PATH = fileURLToPath(
  new URL(
    '../../node_modules/@modelcontextprotocol/server-sequential-thinking/dist/index.js',
    import.meta.url
  )
)
const PLAYWRIGHT_MCP_PATH = fileURLToPath(
  new URL('../../node_modules/@playwright/mcp/cli.js', import.meta.url)
)
const MCP_DATA_DIRECTORY = join(process.cwd(), 'data')
const MCP_MEMORY_PATH = join(MCP_DATA_DIRECTORY, '.agent-memory.jsonl')
const MAIL_MCP_URL = 'https://mail.pmh.codes/api/external/v1/mcp'
const spotifyAuthenticationTool = tool({
  name: 'spotify_authenticate',
  description:
    'Start Spotify MCP authentication without terminal access. Use the Spotify app client ID and its exact public redirect URI, which must end in /mcp/spotify/callback. Return the generated authorization link to the user.',
  inputSchema: z.object({
    clientId: z.string().describe('Client ID from the Spotify Developer Dashboard'),
    redirectUri: z
      .string()
      .describe('Public HTTPS callback URI registered in Spotify, ending /mcp/spotify/callback')
  }),
  callback: ({ clientId, redirectUri }) => {
    const authorizationUrl = beginSpotifyAuthentication(clientId, redirectUri)
    return `Open this Spotify authorization link within 10 minutes: ${authorizationUrl}`
  }
})

export const GPT_MODELS = [
  { id: 'gpt-5.4', label: 'GPT-5.4' },
  { id: 'gpt-5.4-pro', label: 'GPT-5.4 pro' },
  { id: 'gpt-5.4-mini', label: 'GPT-5.4 mini' },
  { id: 'gpt-5.4-nano', label: 'GPT-5.4 nano' },
  { id: 'gpt-5.2', label: 'GPT-5.2' },
  { id: 'o3', label: 'o3' },
  { id: 'o4-mini', label: 'o4-mini' }
] as const

const DEFAULT_MODEL = 'gpt-5.4'

export const GPT_EFFORT_OPTIONS = [
  { id: 'none', label: 'None' },
  { id: 'minimal', label: 'Minimal' },
  { id: 'low', label: 'Low' },
  { id: 'medium', label: 'Medium' },
  { id: 'high', label: 'High' },
  { id: 'xhigh', label: 'Extra high' }
] as const

const VERBOSITY_OPTIONS = [
  { id: 'brief', label: 'Brief' },
  { id: 'normal', label: 'Normal' },
  { id: 'detailed', label: 'Detailed' }
] as const

type ModelId = (typeof GPT_MODELS)[number]['id']
type EffortLevel = (typeof GPT_EFFORT_OPTIONS)[number]['id']
type VerbosityLevel = (typeof VERBOSITY_OPTIONS)[number]['id']

interface GptContext {
  prompt: string
  displayPrompt: string
  pub: boolean
  model: ModelId
  effort: EffortLevel
  maxTokens: number
  verbosity: VerbosityLevel
  userId: string
  sessionName: string
  history: ConversationTurn[]
  buttons: GptActionButton[]
  expiresAt: number
}

interface GptActionButton {
  id: string
  label: string
  style: 'primary' | 'secondary' | 'success' | 'danger'
}

interface ConversationTurn {
  role: 'user' | 'assistant'
  content: string
}

interface GptSessionSettings {
  model: ModelId
  effort: EffortLevel
  maxTokens: number
}

const GPT_CONTEXT_KEY = 'gpt-ctx'
const GPT_SESSION_KEY = 'gpt-session'
const GPT_SELECTED_SESSION_KEY = 'gpt-session-selected'
const GPT_SETTINGS_KEY = 'gpt-settings'
const DEFAULT_SESSION_NAME = 'default'
const activeStreams = new Map<string, AbortController>()
const followUpIds = new Map<string, string[]>()
const sessionQueues = new Map<string, Promise<void>>()

function isMcpConnectionClosed(error: unknown): boolean {
  let current = error
  for (let depth = 0; depth < 5 && current; depth++) {
    if (String(current).includes('MCP error -32000: Connection closed')) return true
    current = current instanceof Error ? current.cause : undefined
  }
  return false
}

type AnyRow = ActionRowBuilder<StringSelectMenuBuilder> | ActionRowBuilder<ButtonBuilder>

type GptComponent = ContainerBuilder | AnyRow

function storeGptContext(token: string, ctx: GptContext) {
  setStoredValue(`${GPT_CONTEXT_KEY}:${token}`, JSON.stringify({ ...ctx, history: [] }))
}

function deleteGptContext(token: string): void {
  deleteStoredValue(`${GPT_CONTEXT_KEY}:${token}`)
}

function loadGptContext(token: string): GptContext | null {
  const key = `${GPT_CONTEXT_KEY}:${token}`
  const stored = getStoredValue(key)
  if (!stored) return null
  try {
    const parsed = JSON.parse(stored) as Partial<GptContext>
    if (
      typeof parsed.displayPrompt !== 'string' ||
      typeof parsed.expiresAt !== 'number' ||
      parsed.expiresAt <= Date.now() ||
      !Array.isArray(parsed.buttons) ||
      !parsed.buttons.every(
        (button) =>
          typeof button.id === 'string' &&
          typeof button.label === 'string' &&
          ['primary', 'secondary', 'success', 'danger'].includes(button.style)
      )
    ) {
      deleteStoredValue(key)
      return null
    }
    return parsed as GptContext
  } catch {
    deleteStoredValue(key)
    return null
  }
}

function buttonStyle(style: GptActionButton['style']): ButtonStyle {
  if (style === 'primary') return ButtonStyle.Primary
  if (style === 'success') return ButtonStyle.Success
  if (style === 'danger') return ButtonStyle.Danger
  return ButtonStyle.Secondary
}

function interactionButtonTool(token: string, ctx: GptContext) {
  return tool({
    name: 'manage_interaction_button',
    description:
      'Create, update, or delete a Discord interaction button on this response. Buttons should represent useful user choices. A click is sent back to you so you can rewrite the response. Use a stable short id for each choice. At most 5 buttons may exist.',
    inputSchema: z.object({
      action: z.enum(['create', 'delete']),
      id: z
        .string()
        .regex(/^[a-z0-9_-]{1,32}$/)
        .describe('Stable lowercase button identifier'),
      label: z.string().min(1).max(80).optional(),
      style: z.enum(['primary', 'secondary', 'success', 'danger']).optional()
    }),
    callback: ({ action, id, label, style }) => {
      const existingIndex = ctx.buttons.findIndex((button) => button.id === id)
      if (action === 'delete') {
        if (existingIndex === -1) return `Button ${id} does not exist.`
        ctx.buttons.splice(existingIndex, 1)
        storeGptContext(token, ctx)
        return `Deleted button ${id}.`
      }

      if (!label) return 'A label is required when creating a button.'
      const button: GptActionButton = { id, label, style: style ?? 'secondary' }
      if (existingIndex >= 0) {
        ctx.buttons[existingIndex] = button
      } else if (ctx.buttons.length >= 5) {
        return 'The response already has the maximum of 5 buttons.'
      } else {
        ctx.buttons.push(button)
      }
      storeGptContext(token, ctx)
      return `${existingIndex >= 0 ? 'Updated' : 'Created'} button ${id}.`
    }
  })
}

function selectedSessionKey(userId: string): string {
  return `${GPT_SELECTED_SESSION_KEY}:${userId}`
}

function sessionKey(userId: string, sessionName: string): string {
  return `${GPT_SESSION_KEY}:${userId}:${encodeURIComponent(sessionName)}`
}

function settingsKey(userId: string, sessionName: string): string {
  return `${GPT_SETTINGS_KEY}:${userId}:${encodeURIComponent(sessionName)}`
}

function loadSessionSettings(userId: string, sessionName: string): GptSessionSettings {
  const defaults: GptSessionSettings = {
    model: DEFAULT_MODEL,
    effort: 'medium',
    maxTokens: DEFAULT_MAX_TOKENS
  }
  const stored = getStoredValue(settingsKey(userId, sessionName))
  if (!stored) return defaults

  try {
    const settings = JSON.parse(stored) as Partial<GptSessionSettings>
    const model = settings.model
    const effort = settings.effort
    return {
      model: model && GPT_MODELS.some(({ id }) => id === model) ? model : defaults.model,
      effort:
        effort && GPT_EFFORT_OPTIONS.some(({ id }) => id === effort) ? effort : defaults.effort,
      maxTokens:
        Number.isInteger(settings.maxTokens) &&
        settings.maxTokens !== undefined &&
        settings.maxTokens >= 256 &&
        settings.maxTokens <= 16384
          ? settings.maxTokens
          : defaults.maxTokens
    }
  } catch {
    return defaults
  }
}

function storeSessionSettings(
  userId: string,
  sessionName: string,
  settings: GptSessionSettings
): void {
  setStoredValue(settingsKey(userId, sessionName), JSON.stringify(settings))
}

function loadConversation(userId: string, sessionName: string): ConversationTurn[] {
  const key = sessionKey(userId, sessionName)
  const stored = getStoredValue(key)
  if (stored === undefined) {
    setStoredValue(key, '[]')
    return []
  }

  try {
    const turns = JSON.parse(stored) as ConversationTurn[]
    if (
      !Array.isArray(turns) ||
      !turns.every(
        (turn) =>
          (turn.role === 'user' || turn.role === 'assistant') && typeof turn.content === 'string'
      )
    ) {
      return []
    }
    return turns
  } catch {
    return []
  }
}

function storeConversation(ctx: GptContext, response: string): void {
  setStoredValue(
    sessionKey(ctx.userId, ctx.sessionName),
    JSON.stringify([
      ...ctx.history,
      { role: 'user', content: ctx.prompt },
      { role: 'assistant', content: response }
    ])
  )
}

function agentMessages(history: ConversationTurn[]): MessageData[] {
  return history.map((turn) => ({
    role: turn.role,
    content: [{ text: turn.content }]
  }))
}

async function runInSession(
  userId: string,
  sessionName: string,
  operation: () => Promise<void>
): Promise<void> {
  const key = sessionKey(userId, sessionName)
  const previous = sessionQueues.get(key) ?? Promise.resolve()
  const current = previous.catch(() => {}).then(operation)
  sessionQueues.set(key, current)

  try {
    await current
  } finally {
    if (sessionQueues.get(key) === current) sessionQueues.delete(key)
  }
}

function footerSessionName(sessionName: string): string {
  return escapeMarkdown(sessionName.replace(/\s+/g, ' '))
}

function usageFooter(model: string, effort: EffortLevel, maxTokens: number, usage?: Usage): string {
  const tokens = usage
    ? `${usage.inputTokens.toLocaleString('en-US')} in / ${usage.outputTokens.toLocaleString('en-US')} out / ${usage.totalTokens.toLocaleString('en-US')} total`
    : 'unavailable'
  return `-# Tokens used: ${tokens} | Model: ${model} | Reasoning effort: ${effort} | Token limit: ${maxTokens.toLocaleString('en-US')}`
}

function tokenFromId(customId: string, baseId: string): string | null {
  const prefix = `${baseId}:`
  if (!customId.startsWith(prefix)) return null
  return customId.slice(prefix.length)
}

function buildGptComponents(
  prompt: string,
  content: string,
  sessionName: string,
  pub: boolean,
  token: string,
  model: string,
  effort: EffortLevel,
  maxTokens: number,
  verbosity: VerbosityLevel,
  streaming: boolean,
  usage?: Usage,
  showStats = false,
  buttons: GptActionButton[] = []
): GptComponent[] {
  const displayContent = content ? (streaming ? `${content}\n-# ▌` : content) : '-# generating...'

  const ctr = new ContainerBuilder()
    .addTextDisplayComponents(new TextDisplayBuilder().setContent(`**${prompt}**`))
    .addSeparatorComponents(
      new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small).setDivider(true)
    )
    .addTextDisplayComponents(new TextDisplayBuilder().setContent(displayContent))
    .addSeparatorComponents(
      new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small).setDivider(false)
    )
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(`-# Session: ${footerSessionName(sessionName)}`)
    )

  if (showStats) {
    ctr.addTextDisplayComponents(
      new TextDisplayBuilder().setContent(usageFooter(model, effort, maxTokens, usage))
    )
  }

  const modelRow = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId(`${GPT_MODEL_SELECT_ID}:${token}`)
      .setPlaceholder(`Model: ${model}`)
      .addOptions(
        GPT_MODELS.map((m) => new StringSelectMenuOptionBuilder().setLabel(m.label).setValue(m.id))
      )
  )

  const components: GptComponent[] = [ctr]

  if (buttons.length > 0) {
    components.push(
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        buttons.map((button) =>
          new ButtonBuilder()
            .setCustomId(`${GPT_ACTION_BUTTON_ID}:${token}:${button.id}`)
            .setLabel(button.label)
            .setStyle(buttonStyle(button.style))
        )
      )
    )
  }

  if (!pub) {
    components.push(
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
          .setCustomId(PIN_BUTTON_ID)
          .setLabel('Pin')
          .setStyle(ButtonStyle.Secondary),
        new ButtonBuilder()
          .setCustomId(PUB_BUTTON_ID)
          .setLabel('Publish')
          .setStyle(ButtonStyle.Success)
      ),
      modelRow,
      new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
        new StringSelectMenuBuilder()
          .setCustomId(`${GPT_EFFORT_SELECT_ID}:${token}`)
          .setPlaceholder(`Effort: ${effort}`)
          .addOptions(
            GPT_EFFORT_OPTIONS.map((e) =>
              new StringSelectMenuOptionBuilder().setLabel(e.label).setValue(e.id)
            )
          )
      ),
      new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
        new StringSelectMenuBuilder()
          .setCustomId(`${GPT_VERBOSITY_SELECT_ID}:${token}`)
          .setPlaceholder(`Verbosity: ${verbosity}`)
          .addOptions(
            VERBOSITY_OPTIONS.map((v) =>
              new StringSelectMenuOptionBuilder().setLabel(v.label).setValue(v.id)
            )
          )
      )
    )
  }

  return components
}

function buildFollowUpComponents(
  content: string,
  streaming: boolean,
  stats?: string
): GptComponent[] {
  const displayContent = streaming ? `${content}\n-# ▌` : content
  const ctr = new ContainerBuilder()
    .setAccentColor(GPT_COLOR)
    .addTextDisplayComponents(new TextDisplayBuilder().setContent(displayContent))

  if (stats) {
    ctr
      .addSeparatorComponents(
        new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small).setDivider(false)
      )
      .addTextDisplayComponents(new TextDisplayBuilder().setContent(stats))
  }

  return [ctr]
}

interface StreamCallbacks {
  editMain: (components: GptComponent[]) => Promise<{ id?: string } | unknown>
  followUp: (components: GptComponent[]) => Promise<{ id?: string } | unknown>
  editMessage: (messageId: string, components: GptComponent[]) => Promise<unknown>
  deleteMessage: (messageId: string) => Promise<unknown>
}

function makeCallbacks(
  interaction: {
    editReply: (options: { components: never; flags: number }) => Promise<unknown>
    followUp: (options: { components: never; flags: readonly number[] }) => Promise<unknown>
    webhook: {
      editMessage: (id: string, data: { components: never; flags: number }) => Promise<unknown>
      deleteMessage: (id: string) => Promise<unknown>
    }
  },
  pub: boolean
): StreamCallbacks {
  const msgFlags = pub
    ? MessageFlags.IsComponentsV2
    : MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral
  const followUpFlags: readonly number[] = pub
    ? [MessageFlags.IsComponentsV2]
    : [MessageFlags.IsComponentsV2, MessageFlags.Ephemeral]

  return {
    editMain: (comps) =>
      interaction.editReply({
        components: comps as never,
        flags: MessageFlags.IsComponentsV2
      }),
    followUp: (comps) => interaction.followUp({ components: comps as never, flags: followUpFlags }),
    editMessage: (id, comps) =>
      interaction.webhook.editMessage(id, {
        components: comps as never,
        flags: msgFlags
      }),
    deleteMessage: (id) => interaction.webhook.deleteMessage(id)
  }
}

async function runGptStream(
  callbacks: StreamCallbacks,
  ctx: GptContext,
  token: string
): Promise<void> {
  const apiKey = process.env.OPENAI_API_KEY
  if (!apiKey) {
    await callbacks.editMain(
      buildGptComponents(
        ctx.displayPrompt,
        'no OPENAI_API_KEY',
        ctx.sessionName,
        ctx.pub,
        token,
        ctx.model,
        ctx.effort,
        ctx.maxTokens,
        ctx.verbosity,
        false,
        undefined,
        true,
        ctx.buttons
      )
    )
    return
  }

  const existing = activeStreams.get(token)
  existing?.abort()

  const oldFollowUps = followUpIds.get(token) ?? []
  for (const id of oldFollowUps) {
    await callbacks.deleteMessage(id).catch(() => {})
  }
  followUpIds.set(token, [])

  const controller = new AbortController()
  activeStreams.set(token, controller)

  let currentPage = 1
  let currentPageContent = ''
  let responseContent = ''
  let lastEditTime = 0
  let usage: Usage | undefined
  const mcpClients: McpClient[] = []
  let activeDisplayType: 'reasoning' | 'text' | null = null
  let hasTrace = false
  let displayedWebSearch = false
  const toolNames = new Map<string, string>()

  const editCurrentPage = async (content: string, streaming: boolean, complete = false) => {
    if (currentPage === 1) {
      await callbacks.editMain(
        buildGptComponents(
          ctx.displayPrompt,
          content,
          ctx.sessionName,
          ctx.pub,
          token,
          ctx.model,
          ctx.effort,
          ctx.maxTokens,
          ctx.verbosity,
          streaming,
          complete ? usage : undefined,
          complete,
          ctx.buttons
        )
      )
    } else {
      const pageIds = followUpIds.get(token) ?? []
      const pageId = pageIds[currentPage - 2]
      if (pageId) {
        await callbacks.editMessage(
          pageId,
          buildFollowUpComponents(
            content,
            streaming,
            complete ? usageFooter(ctx.model, ctx.effort, ctx.maxTokens, usage) : undefined
          )
        )
      }
    }
  }

  const overflowToNewPage = async () => {
    await editCurrentPage(currentPageContent, false)
    currentPage++
    currentPageContent = ''

    const msg = (await callbacks.followUp(buildFollowUpComponents('-# generating...', true))) as {
      id?: string
    }

    if (msg?.id) {
      const ids = followUpIds.get(token) ?? []
      ids.push(msg.id)
      followUpIds.set(token, ids)
    }
  }

  const appendDisplayContent = async (content: string) => {
    currentPageContent += content
    if (currentPageContent.length > PAGE_LIMIT) {
      const overflow = currentPageContent.slice(PAGE_LIMIT)
      currentPageContent = currentPageContent.slice(0, PAGE_LIMIT)
      await overflowToNewPage()
      currentPageContent = overflow
    }
  }

  const updateStreamingDisplay = async () => {
    const now = Date.now()
    if (now - lastEditTime >= EDIT_INTERVAL_MS) {
      await editCurrentPage(currentPageContent, true)
      lastEditTime = now
    }
  }

  try {
    const systemInstruction =
      ctx.verbosity === 'brief'
        ? 'Be concise and to the point. Keep responses short.'
        : ctx.verbosity === 'detailed'
          ? 'Be thorough and comprehensive. Explain in detail.'
          : null

    const model = new OpenAIModel({
      api: 'responses',
      modelId: ctx.model,
      apiKey,
      maxTokens: ctx.maxTokens,
      params: {
        tools: [{ type: 'web_search' }],
        ...(ctx.effort !== 'none' ? { reasoning: { effort: ctx.effort } } : {})
      }
    })
    mcpClients.push(
      new McpClient({
        applicationName: 'solver /a Docker',
        transport: new StdioClientTransport({
          command: 'uvx',
          args: ['mcp-server-docker']
        })
      }),
      new McpClient({
        applicationName: 'solver /a Filesystem',
        transport: new StdioClientTransport({
          command: process.execPath,
          args: [FILESYSTEM_MCP_PATH, MCP_DATA_DIRECTORY]
        })
      }),
      new McpClient({
        applicationName: 'solver /a Memory',
        transport: new StdioClientTransport({
          command: process.execPath,
          args: [MEMORY_MCP_PATH],
          env: { MEMORY_FILE_PATH: MCP_MEMORY_PATH }
        })
      }),
      new McpClient({
        applicationName: 'solver /a Sequential Thinking',
        transport: new StdioClientTransport({
          command: process.execPath,
          args: [SEQUENTIAL_THINKING_MCP_PATH]
        })
      }),
      new McpClient({
        applicationName: 'solver /a Fetch',
        transport: new StdioClientTransport({
          command: 'uvx',
          args: ['mcp-server-fetch==2026.7.10']
        })
      }),
      new McpClient({
        applicationName: 'solver /a Time',
        transport: new StdioClientTransport({
          command: 'uvx',
          args: ['mcp-server-time==2026.7.10']
        })
      }),
      new McpClient({
        applicationName: 'solver /a Playwright',
        transport: new StdioClientTransport({
          command: process.execPath,
          args: [
            PLAYWRIGHT_MCP_PATH,
            '--headless',
            '--isolated',
            '--no-sandbox',
            '--image-responses',
            'omit',
            '--executable-path',
            '/usr/bin/chromium'
          ]
        })
      })
    )
    const spotifyConfiguration = await loadSpotifyConfiguration()
    if (spotifyConfiguration) {
      mcpClients.push(
        new McpClient({
          applicationName: 'solver /a',
          transport: new StdioClientTransport({
            command: process.execPath,
            args: [SPOTIFY_MCP_PATH],
            env: getSpotifyMcpEnvironment(spotifyConfiguration)
          })
        })
      )
    }
    const mailApiKey = process.env.MAIL_API_KEY?.trim()
    if (mailApiKey) {
      mcpClients.push(
        new McpClient({
          applicationName: 'solver /a Mail',
          transport: new StreamableHTTPClientTransport(new URL(MAIL_MCP_URL), {
            requestInit: { headers: { Authorization: `Bearer ${mailApiKey}` } }
          })
        })
      )
    }
    const streamAgent = async (prompt: string, diagnosing = false) => {
      const buttonTool = interactionButtonTool(token, ctx)
      const agent = new Agent({
        model,
        messages: agentMessages(ctx.history),
        systemPrompt: diagnosing
          ? [
              systemInstruction,
              'Diagnose the reported MCP connection failure for the user. Explain the likely cause and concrete recovery checks. Do not claim to have run checks or use MCP tools, because those clients disconnected.'
            ]
              .filter(Boolean)
              .join('\n')
          : (systemInstruction ?? undefined),
        tools: diagnosing
          ? [spotifyAuthenticationTool, buttonTool]
          : [spotifyAuthenticationTool, buttonTool, ...mcpClients],
        printer: false
      })

      for await (const event of agent.stream(prompt, {
        cancelSignal: controller.signal,
        limits: { turns: 8, outputTokens: ctx.maxTokens }
      })) {
        if (controller.signal.aborted) break

        if (event.type === 'modelStreamUpdateEvent') {
          if (
            event.event.type === 'modelContentBlockStartEvent' &&
            event.event.start?.type === 'toolUseStart'
          ) {
            const { name, toolUseId } = event.event.start
            toolNames.set(toolUseId, name)
            await appendDisplayContent(
              `${currentPageContent ? '\n\n' : ''}**Tool:** ${escapeMarkdown(name)}`
            )
            activeDisplayType = null
            hasTrace = true
            await updateStreamingDisplay()
          }

          if (event.event.type === 'modelContentBlockDeltaEvent') {
            if (event.event.delta.type === 'reasoningContentDelta' && event.event.delta.text) {
              const heading =
                activeDisplayType === 'reasoning'
                  ? ''
                  : `${currentPageContent ? '\n\n' : ''}**Reasoning**\n`
              await appendDisplayContent(`${heading}${event.event.delta.text}`)
              activeDisplayType = 'reasoning'
              hasTrace = true
              await updateStreamingDisplay()
            }

            if (event.event.delta.type === 'citationsDelta' && !displayedWebSearch) {
              await appendDisplayContent(
                `${currentPageContent ? '\n\n' : ''}**Tool:** web\\_search\n-# web\\_search succeeded`
              )
              activeDisplayType = null
              hasTrace = true
              displayedWebSearch = true
              await updateStreamingDisplay()
            }

            if (event.event.delta.type === 'textDelta') {
              const heading =
                hasTrace && activeDisplayType !== 'text'
                  ? `${currentPageContent ? '\n\n' : ''}**Response**\n`
                  : ''
              await appendDisplayContent(`${heading}${event.event.delta.text}`)
              responseContent += event.event.delta.text
              activeDisplayType = 'text'
              await updateStreamingDisplay()
            }
          }
        }
        if (event.type === 'toolResultEvent') {
          const name = toolNames.get(event.result.toolUseId) ?? 'unknown tool'
          const status = event.result.status === 'success' ? 'succeeded' : 'failed'
          await appendDisplayContent(`\n-# ${escapeMarkdown(name)} ${status}`)
          activeDisplayType = null
          hasTrace = true
          await updateStreamingDisplay()
        }
        if (event.type === 'agentResultEvent') {
          usage = event.result.metrics?.latestAgentInvocation?.usage
        }
      }
    }

    try {
      await streamAgent(ctx.prompt)
    } catch (error) {
      if (!isMcpConnectionClosed(error) || controller.signal.aborted) throw error

      for (const id of followUpIds.get(token) ?? []) {
        await callbacks.deleteMessage(id).catch(() => {})
      }
      followUpIds.set(token, [])
      currentPage = 1
      currentPageContent = ''
      responseContent = ''
      lastEditTime = 0
      usage = undefined
      activeDisplayType = null
      hasTrace = false
      displayedWebSearch = false
      toolNames.clear()
      await editCurrentPage('-# diagnosing MCP connection failure...', true)

      const integrations = [
        'Docker MCP (`uvx mcp-server-docker`)',
        'Filesystem MCP',
        'Memory MCP',
        'Sequential Thinking MCP',
        'Fetch MCP',
        'Time MCP',
        'Playwright MCP',
        ...(spotifyConfiguration ? ['Spotify MCP'] : []),
        ...(mailApiKey ? ['Mail MCP'] : [])
      ].join(' and ')
      await streamAgent(
        `The original request was: ${ctx.prompt}\n\nThe agent encountered "MCP error -32000: Connection closed" while loading or using ${integrations}. Diagnose what likely went wrong and tell the user how to recover. If possible, also answer the original request without MCP tools.`,
        true
      )
    }

    if (!controller.signal.aborted) {
      const response = responseContent || '(no response)'
      await editCurrentPage(currentPageContent || response, false, true)
      storeConversation(ctx, response)
    }
  } catch (error) {
    if (
      error instanceof Error &&
      (error.name === 'AbortError' || error.message.includes('abort'))
    ) {
      return
    }

    const errMsg = error instanceof Error ? error.message : 'unknown error'
    await callbacks.editMain(
      buildGptComponents(
        ctx.displayPrompt,
        `error: ${errMsg}`,
        ctx.sessionName,
        ctx.pub,
        token,
        ctx.model,
        ctx.effort,
        ctx.maxTokens,
        ctx.verbosity,
        false,
        undefined,
        true,
        ctx.buttons
      )
    )
  } finally {
    await Promise.all(mcpClients.map((client) => client.disconnect().catch(() => {})))
    activeStreams.delete(token)
  }
}

type SelectKey = 'model' | 'effort' | 'verbosity'

function selectBaseId(key: SelectKey): string {
  if (key === 'model') return GPT_MODEL_SELECT_ID
  if (key === 'effort') return GPT_EFFORT_SELECT_ID
  return GPT_VERBOSITY_SELECT_ID
}

async function handleGptSelect(
  interaction: StringSelectMenuInteraction,
  key: SelectKey
): Promise<void> {
  const token = tokenFromId(interaction.customId, selectBaseId(key))
  if (!token) return

  const ctx = loadGptContext(token)
  if (!ctx) {
    await interaction.reply(container('gpt', new Map(), 'session expired'))
    return
  }

  const value = interaction.values[0]
  if (!value) return

  const updatedCtx: GptContext = { ...ctx, [key]: value }
  storeGptContext(token, updatedCtx)

  await interaction.deferUpdate()

  const callbacks = makeCallbacks(interaction, ctx.pub)

  await callbacks.editMain(
    buildGptComponents(
      updatedCtx.prompt,
      '',
      updatedCtx.sessionName,
      updatedCtx.pub,
      token,
      updatedCtx.model,
      updatedCtx.effort,
      updatedCtx.maxTokens,
      updatedCtx.verbosity,
      true,
      undefined,
      false,
      updatedCtx.buttons
    )
  )

  try {
    await runGptStream(callbacks, updatedCtx, token)
  } finally {
    if (updatedCtx.buttons.length === 0) deleteGptContext(token)
    else storeGptContext(token, updatedCtx)
  }
}

export async function handleGptModelSelect(
  interaction: StringSelectMenuInteraction
): Promise<void> {
  await handleGptSelect(interaction, 'model')
}

export async function handleGptEffortSelect(
  interaction: StringSelectMenuInteraction
): Promise<void> {
  await handleGptSelect(interaction, 'effort')
}

export async function handleGptVerbositySelect(
  interaction: StringSelectMenuInteraction
): Promise<void> {
  await handleGptSelect(interaction, 'verbosity')
}

export function isGptSelectId(customId: string): boolean {
  return (
    matchesInteractiveId(customId, GPT_MODEL_SELECT_ID) ||
    matchesInteractiveId(customId, GPT_EFFORT_SELECT_ID) ||
    matchesInteractiveId(customId, GPT_VERBOSITY_SELECT_ID)
  )
}

export function isGptActionButtonId(customId: string): boolean {
  return customId.startsWith(`${GPT_ACTION_BUTTON_ID}:`)
}

export async function handleGptActionButton(interaction: ButtonInteraction): Promise<void> {
  const match = /^gpt-action:([^:]+):([a-z0-9_-]{1,32})$/.exec(interaction.customId)
  if (!match) return
  const token = match[1]!
  const buttonId = match[2]!
  const ctx = loadGptContext(token)
  const button = ctx?.buttons.find((candidate) => candidate.id === buttonId)
  if (!ctx || !button) {
    await interaction.reply(container('agent', new Map(), 'interaction expired'))
    return
  }

  await interaction.deferUpdate()
  await runInSession(ctx.userId, ctx.sessionName, async () => {
    ctx.history = loadConversation(ctx.userId, ctx.sessionName)
    ctx.prompt = `A Discord user clicked the interaction button "${button.label}" (id: ${button.id}). Rewrite the response to handle that choice. You may create, update, or delete interaction buttons as appropriate.`
    storeGptContext(token, ctx)

    const callbacks = makeCallbacks(interaction, ctx.pub)
    await callbacks.editMain(
      buildGptComponents(
        ctx.displayPrompt,
        '',
        ctx.sessionName,
        ctx.pub,
        token,
        ctx.model,
        ctx.effort,
        ctx.maxTokens,
        ctx.verbosity,
        true,
        undefined,
        false,
        ctx.buttons
      )
    )
    await runGptStream(callbacks, ctx, token)
    if (ctx.buttons.length === 0) deleteGptContext(token)
    else storeGptContext(token, ctx)
  })
}

export async function handleAgentCommand(interaction: ChatInputCommandInteraction): Promise<void> {
  const prompt = interaction.options.getString('prompt', true).trim()
  const requestedSession = interaction.options.getString('session')?.trim()
  const sessionName =
    requestedSession ||
    getStoredValue(selectedSessionKey(interaction.user.id)) ||
    DEFAULT_SESSION_NAME
  setStoredValue(selectedSessionKey(interaction.user.id), sessionName)
  loadConversation(interaction.user.id, sessionName)

  const storedSettings = loadSessionSettings(interaction.user.id, sessionName)
  const requestedModel = interaction.options.getString('model') as ModelId | null
  const requestedEffort = interaction.options.getString('effort') as EffortLevel | null
  const requestedMaxTokens = interaction.options.getInteger('tokens')
  const settings: GptSessionSettings = {
    model: requestedModel ?? storedSettings.model,
    effort: requestedEffort ?? storedSettings.effort,
    maxTokens: requestedMaxTokens ?? storedSettings.maxTokens
  }
  storeSessionSettings(interaction.user.id, sessionName, settings)
  const pub = true
  const token = randomUUID().replace(/-/g, '').slice(0, 16)
  const ctx: GptContext = {
    prompt,
    displayPrompt: prompt,
    pub,
    model: settings.model,
    effort: settings.effort,
    maxTokens: settings.maxTokens,
    verbosity: 'normal',
    userId: interaction.user.id,
    sessionName,
    history: [],
    buttons: [],
    expiresAt: Date.now() + GPT_INTERACTION_TTL_MS
  }

  await interaction.deferReply()

  await interaction.editReply({
    components: buildGptComponents(
      prompt,
      '',
      sessionName,
      pub,
      token,
      settings.model,
      settings.effort,
      settings.maxTokens,
      'normal',
      true
    ) as never,
    flags: MessageFlags.IsComponentsV2
  })

  const callbacks = makeCallbacks(interaction, pub)
  await runInSession(interaction.user.id, sessionName, async () => {
    ctx.history = loadConversation(interaction.user.id, sessionName)
    storeGptContext(token, ctx)
    try {
      await runGptStream(callbacks, ctx, token)
    } finally {
      if (ctx.buttons.length === 0) deleteGptContext(token)
      else storeGptContext(token, ctx)
    }
  })
}
