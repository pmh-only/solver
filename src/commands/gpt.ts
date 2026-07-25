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
import type { ChatInputCommandInteraction, StringSelectMenuInteraction } from 'discord.js'
import { Agent, McpClient, tool, type MessageData } from '@strands-agents/sdk'
import type { Usage } from '@strands-agents/sdk'
import { OpenAIModel } from '@strands-agents/sdk/models/openai'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
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
export const AGENT_COMMAND_NAME = 'a'

const GPT_COLOR = 0x10a37f
const PAGE_LIMIT = 3600
const EDIT_INTERVAL_MS = 750
const DEFAULT_MAX_TOKENS = 4096
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
  pub: boolean
  model: ModelId
  effort: EffortLevel
  maxTokens: number
  verbosity: VerbosityLevel
  userId: string
  sessionName: string
  history: ConversationTurn[]
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
  setStoredValue(`${GPT_CONTEXT_KEY}:${token}`, JSON.stringify(ctx))
}

function deleteGptContext(token: string): void {
  deleteStoredValue(`${GPT_CONTEXT_KEY}:${token}`)
}

function loadGptContext(token: string): GptContext | null {
  const stored = getStoredValue(`${GPT_CONTEXT_KEY}:${token}`)
  if (!stored) return null
  try {
    return JSON.parse(stored) as GptContext
  } catch {
    return null
  }
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
  showStats = false
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
        ctx.prompt,
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
        true
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

  const editCurrentPage = async (content: string, streaming: boolean, complete = false) => {
    if (currentPage === 1) {
      await callbacks.editMain(
        buildGptComponents(
          ctx.prompt,
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
          complete
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
    const streamAgent = async (prompt: string, diagnosing = false) => {
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
          ? [spotifyAuthenticationTool]
          : [spotifyAuthenticationTool, ...mcpClients],
        printer: false
      })

      for await (const event of agent.stream(prompt, {
        cancelSignal: controller.signal,
        limits: { turns: 8, outputTokens: ctx.maxTokens }
      })) {
        if (controller.signal.aborted) break

        if (
          event.type === 'modelStreamUpdateEvent' &&
          event.event.type === 'modelContentBlockDeltaEvent' &&
          event.event.delta.type === 'textDelta'
        ) {
          currentPageContent += event.event.delta.text
          responseContent += event.event.delta.text

          if (currentPageContent.length > PAGE_LIMIT) {
            const overflow = currentPageContent.slice(PAGE_LIMIT)
            currentPageContent = currentPageContent.slice(0, PAGE_LIMIT)
            await overflowToNewPage()
            currentPageContent = overflow
          }

          const now = Date.now()
          if (now - lastEditTime >= EDIT_INTERVAL_MS) {
            await editCurrentPage(currentPageContent, true)
            lastEditTime = now
          }
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
      await editCurrentPage('-# diagnosing MCP connection failure...', true)

      const integrations = [
        'Docker MCP (`uvx mcp-server-docker`)',
        'Filesystem MCP',
        'Memory MCP',
        'Sequential Thinking MCP',
        'Fetch MCP',
        'Time MCP',
        'Playwright MCP',
        ...(spotifyConfiguration ? ['Spotify MCP'] : [])
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
        ctx.prompt,
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
        true
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
      true
    )
  )

  try {
    await runGptStream(callbacks, updatedCtx, token)
  } finally {
    deleteGptContext(token)
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
    pub,
    model: settings.model,
    effort: settings.effort,
    maxTokens: settings.maxTokens,
    verbosity: 'normal',
    userId: interaction.user.id,
    sessionName,
    history: []
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
      deleteGptContext(token)
    }
  })
}
