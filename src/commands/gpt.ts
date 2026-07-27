import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ComponentType,
  ContainerBuilder,
  createComponentBuilder,
  escapeMarkdown,
  MessageFlags,
  ModalBuilder,
  SeparatorBuilder,
  SeparatorSpacingSize,
  StringSelectMenuBuilder,
  StringSelectMenuOptionBuilder,
  TextDisplayBuilder
} from 'discord.js'
import type {
  ChatInputCommandInteraction,
  InteractionEditReplyOptions,
  MessageComponentInteraction,
  ModalSubmitInteraction,
  StringSelectMenuInteraction
} from 'discord.js'
import { Agent, McpClient, tool, type MessageData, type Tool } from '@strands-agents/sdk'
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
import { hostedPageUrl, writeHostedHtml } from '../hosted-page.js'
import {
  beginGoogleCalendarAuthentication,
  getGoogleCalendarMcpEnvironment,
  loadGoogleCalendarConfiguration
} from '../google-calendar-auth.js'
import {
  beginSpotifyAuthentication,
  getSpotifyMcpEnvironment,
  loadSpotifyConfiguration
} from '../spotify-auth.js'

export const GPT_MODEL_SELECT_ID = 'gpt-model'
export const GPT_EFFORT_SELECT_ID = 'gpt-effort'
export const GPT_VERBOSITY_SELECT_ID = 'gpt-verbosity'
export const GPT_ACTION_COMPONENT_ID = 'gpt-action'
export const GPT_MODAL_ID = 'gpt-modal'
export const AGENT_COMMAND_NAME = 'a'

const DEFAULT_MAX_TOKENS = 4096
const GPT_INTERACTION_TTL_MS = 7 * 24 * 60 * 60 * 1000
const SPOTIFY_MCP_PATH = fileURLToPath(
  new URL('../../node_modules/spotify-mcp/dist/index.js', import.meta.url)
)
const GOOGLE_CALENDAR_MCP_PATH = fileURLToPath(
  new URL('../../node_modules/@cocal/google-calendar-mcp/build/index.js', import.meta.url)
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
const publishHtmlTool = tool({
  name: 'publish_html',
  description:
    'Publish a complete single-file HTML page at the configured web domain. Include all CSS and JavaScript in the HTML. Publishing replaces the previously hosted page and persists across restarts.',
  inputSchema: z.object({
    html: z.string().describe('Complete HTML document to publish, up to 1 MiB')
  }),
  callback: async ({ html }) => {
    await writeHostedHtml(html)
    const url = hostedPageUrl()
    return url
      ? `Published the persistent HTML page at ${url}`
      : 'Published the persistent HTML page. WEB_DOMAIN is not configured, so no public URL is available.'
  }
})
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
const googleCalendarAuthenticationTool = tool({
  name: 'google_calendar_authenticate',
  description:
    'Start Google Calendar authentication through the bot public callback. Use this instead of the Calendar MCP manage-accounts add action, whose localhost callback is not reachable in deployment. Return the generated Google login link to the user.',
  inputSchema: z.object({
    accountId: z
      .string()
      .default('personal')
      .describe('Lowercase nickname for this Google account, such as personal or work')
  }),
  callback: async ({ accountId }) => {
    const authorizationUrl = await beginGoogleCalendarAuthentication(accountId)
    return `Open this Google Calendar authorization link within 10 minutes: ${authorizationUrl}`
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
  components: GptManagedComponent[]
  senderOnlyComponentIds: string[]
  modals: Record<string, GptManagedComponent>
  expiresAt: number
}

type GptManagedComponent = Record<string, unknown>

interface ConversationTurn {
  role: 'user' | 'assistant'
  content: string
}

interface AgentActivity {
  reasoning: string
  tools: Array<{ id: string; name: string; status: 'running' | 'success' | 'error' }>
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
const sessionQueues = new Map<string, Promise<void>>()

function isMcpConnectionClosed(error: unknown): boolean {
  let current = error
  for (let depth = 0; depth < 5 && current; depth++) {
    if (String(current).includes('MCP error -32000: Connection closed')) return true
    current = current instanceof Error ? current.cause : undefined
  }
  return false
}

function replaceDuplicateTools<T extends { name: string }>(tools: T[]): T[] {
  const toolsByNormalizedName = new Map<string, T>()
  for (const candidate of tools) {
    toolsByNormalizedName.set(candidate.name.replaceAll('-', '_'), candidate)
  }
  return [...toolsByNormalizedName.values()]
}

async function loadMcpTools(clients: McpClient[]): Promise<Tool[]> {
  const toolsByClient = await Promise.all(clients.map((client) => client.listTools()))
  return toolsByClient.flat()
}

type AnyRow = ActionRowBuilder<StringSelectMenuBuilder> | ActionRowBuilder<ButtonBuilder>

type GptComponent = ContainerBuilder | AnyRow | GptManagedComponent

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
    const parsed = JSON.parse(stored) as Partial<GptContext> & {
      buttons?: Array<{ id: string; label: string; style: string }>
    }
    if (
      typeof parsed.displayPrompt !== 'string' ||
      typeof parsed.expiresAt !== 'number' ||
      parsed.expiresAt <= Date.now() ||
      (!Array.isArray(parsed.components) &&
        (!Array.isArray(parsed.buttons) ||
          !parsed.buttons.every(
            (button) =>
              typeof button.id === 'string' &&
              typeof button.label === 'string' &&
              ['primary', 'secondary', 'success', 'danger'].includes(button.style)
          )))
    ) {
      deleteStoredValue(key)
      return null
    }
    if (!Array.isArray(parsed.components)) {
      const buttons = parsed.buttons!
      parsed.components = [
        {
          type: ComponentType.ActionRow,
          components: buttons.map((button) => ({
            type: ComponentType.Button,
            custom_id: `${GPT_ACTION_COMPONENT_ID}:${token}:${button.id}`,
            label: button.label,
            style: buttonStyle(button.style)
          }))
        }
      ]
    }
    if (parsed.senderOnlyComponentIds === undefined) {
      parsed.senderOnlyComponentIds = []
    } else if (
      !Array.isArray(parsed.senderOnlyComponentIds) ||
      !parsed.senderOnlyComponentIds.every((id) => typeof id === 'string')
    ) {
      throw new Error('Invalid sender-only component ids.')
    }
    if (!parsed.modals || typeof parsed.modals !== 'object' || Array.isArray(parsed.modals)) {
      parsed.modals = {}
    }
    for (const [triggerId, modal] of Object.entries(parsed.modals)) {
      if (
        !/^[a-z0-9_-]{1,32}$/.test(triggerId) ||
        !modal ||
        typeof modal !== 'object' ||
        (modal as GptManagedComponent).custom_id !== `${GPT_MODAL_ID}:${token}:${triggerId}`
      ) {
        throw new Error('Invalid stored modal.')
      }
      ModalBuilder.from(modal as never).toJSON()
    }
    return parsed as GptContext
  } catch {
    deleteStoredValue(key)
    return null
  }
}

function buttonStyle(style: string): ButtonStyle {
  if (style === 'primary') return ButtonStyle.Primary
  if (style === 'success') return ButtonStyle.Success
  if (style === 'danger') return ButtonStyle.Danger
  return ButtonStyle.Secondary
}

function namespaceComponentIds(
  value: unknown,
  token: string,
  ids: Set<string>,
  senderOnlyIds: Set<string>
): void {
  if (Array.isArray(value)) {
    for (const item of value) namespaceComponentIds(item, token, ids, senderOnlyIds)
    return
  }
  if (!value || typeof value !== 'object') return

  const component = value as Record<string, unknown>
  const senderOnly = component.sender_only
  if (senderOnly !== undefined && typeof senderOnly !== 'boolean') {
    throw new Error('sender_only must be a boolean.')
  }
  delete component.sender_only
  if (typeof component.custom_id === 'string') {
    if (!/^[a-z0-9_-]{1,32}$/.test(component.custom_id)) {
      throw new Error(`Invalid component id: ${component.custom_id}`)
    }
    if (ids.has(component.custom_id))
      throw new Error(`Duplicate component id: ${component.custom_id}`)
    ids.add(component.custom_id)
    if (senderOnly) senderOnlyIds.add(component.custom_id)
    component.custom_id = `${GPT_ACTION_COMPONENT_ID}:${token}:${component.custom_id}`
  } else if (senderOnly) {
    throw new Error('sender_only requires an interactive component with custom_id.')
  }
  for (const child of Object.values(component)) {
    namespaceComponentIds(child, token, ids, senderOnlyIds)
  }
}

function validateComponents(
  input: string,
  token: string
): { components: GptManagedComponent[]; senderOnlyIds: string[] } {
  const parsed: unknown = JSON.parse(input)
  if (!Array.isArray(parsed)) throw new Error('Components must be a JSON array.')
  if (parsed.length > 10) throw new Error('At most 10 top-level components may exist.')

  const components = structuredClone(parsed) as GptManagedComponent[]
  const senderOnlyIds = new Set<string>()
  namespaceComponentIds(components, token, new Set(), senderOnlyIds)
  let count = 0
  const countComponents = (value: unknown): void => {
    if (Array.isArray(value)) {
      for (const item of value) countComponents(item)
      return
    }
    if (!value || typeof value !== 'object') return
    const component = value as Record<string, unknown>
    if (typeof component.type === 'number') count++
    if (Array.isArray(component.components)) countComponents(component.components)
  }
  countComponents(components)
  if (count > 30) throw new Error('At most 30 generated components may exist.')

  const topLevelTypes = new Set([
    ComponentType.ActionRow,
    ComponentType.Section,
    ComponentType.TextDisplay,
    ComponentType.MediaGallery,
    ComponentType.File,
    ComponentType.Separator,
    ComponentType.Container
  ])
  const validated = components.map((component) => {
    if (!topLevelTypes.has(component.type as ComponentType)) {
      throw new Error(`Component type ${String(component.type)} cannot be top-level.`)
    }
    return createComponentBuilder(component as never).toJSON() as unknown as GptManagedComponent
  })
  return { components: validated, senderOnlyIds: [...senderOnlyIds] }
}

function validateModal(input: string, token: string, triggerId: string): GptManagedComponent {
  const parsed: unknown = JSON.parse(input)
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Modal must be a JSON object.')
  }
  const modal = structuredClone(parsed) as GptManagedComponent
  modal.custom_id = `${GPT_MODAL_ID}:${token}:${triggerId}`
  return new ModalBuilder(modal as never).toJSON() as unknown as GptManagedComponent
}

function interactionModalTool(token: string, ctx: GptContext) {
  return tool({
    name: 'manage_response_modals',
    description:
      'Set, remove, or clear Discord modals opened by buttons in your response JSON. trigger_id must match the stable custom_id of a button in the response. modal_json is a complete Discord API modal object and supports legacy action-row text inputs plus Components V2 text displays and labels containing selects, text inputs, file uploads, radio groups, checkboxes, and checkbox groups. The modal custom_id is managed automatically. Submitted field values are sent back to you.',
    inputSchema: z.object({
      action: z.enum(['set', 'remove', 'clear']),
      trigger_id: z
        .string()
        .regex(/^[a-z0-9_-]{1,32}$/)
        .optional(),
      modal_json: z
        .string()
        .optional()
        .describe('Complete Discord API modal object; required for set')
    }),
    callback: ({ action, trigger_id, modal_json }) => {
      if (action === 'clear') {
        ctx.modals = {}
        storeGptContext(token, ctx)
        return 'Cleared response modals.'
      }
      if (!trigger_id) return 'trigger_id is required.'
      if (action === 'remove') {
        delete ctx.modals[trigger_id]
        storeGptContext(token, ctx)
        return `Removed modal for ${trigger_id}.`
      }
      if (!modal_json) return 'modal_json is required when setting a modal.'
      try {
        ctx.modals[trigger_id] = validateModal(modal_json, token, trigger_id)
      } catch (error) {
        return `Invalid modal: ${error instanceof Error ? error.message : String(error)}`
      }
      storeGptContext(token, ctx)
      return `Set modal for ${trigger_id}.`
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

function formatAgentActivity(activity: AgentActivity): string {
  const sections: string[] = []
  const reasoning = activity.reasoning.trim()
  if (reasoning) {
    const limit = 1200
    sections.push(
      `**Reasoning**\n${reasoning.length > limit ? `${reasoning.slice(0, limit - 3)}...` : reasoning}`
    )
  }
  if (activity.tools.length > 0) {
    const tools = activity.tools.slice(0, 20).map(({ name, status }) => {
      const label = name.replaceAll('`', '')
      return `- \`${label}\`: ${status}`
    })
    if (activity.tools.length > tools.length)
      tools.push(`- ${activity.tools.length - tools.length} more`)
    sections.push(`**Tools used**\n${tools.join('\n')}`)
  }
  const summary = sections.join('\n\n')
  const limit = 1500
  return summary.length > limit ? `${summary.slice(0, limit - 3)}...` : summary
}

function parseJsonObject(input: string): Record<string, unknown> {
  const trimmed = input.trim()
  const json = trimmed.startsWith('```')
    ? trimmed.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '')
    : trimmed
  const parsed: unknown = JSON.parse(json)
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('The response must be a JSON object.')
  }
  return parsed as Record<string, unknown>
}

function appendFooterToEmbed(embed: Record<string, unknown>, footer: string): void {
  const current = embed.footer
  const plainFooter = footer.replace(/^-# /, '')
  const currentText =
    current &&
    typeof current === 'object' &&
    typeof (current as Record<string, unknown>).text === 'string'
      ? ((current as Record<string, unknown>).text as string)
      : ''
  const available = Math.max(0, 2048 - plainFooter.length - (currentText ? 1 : 0))
  const text = `${currentText.slice(0, available)}${currentText ? '\n' : ''}${plainFooter}`
  embed.footer = {
    ...(current && typeof current === 'object' ? current : {}),
    text
  }
}

function normalizePoll(value: unknown): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value
  const poll = structuredClone(value) as Record<string, unknown>
  const answers = Array.isArray(poll.answers)
    ? poll.answers.map((answer) => {
        if (!answer || typeof answer !== 'object') return answer
        const raw = answer as Record<string, unknown>
        return raw.poll_media && typeof raw.poll_media === 'object' ? raw.poll_media : raw
      })
    : poll.answers
  return {
    question: poll.question,
    answers,
    duration: poll.duration,
    allowMultiselect: poll.allowMultiselect ?? poll.allow_multiselect,
    ...(poll.layoutType !== undefined || poll.layout_type !== undefined
      ? { layoutType: poll.layoutType ?? poll.layout_type }
      : {})
  }
}

function buildAgentPayload(
  response: string,
  token: string,
  ctx: GptContext,
  usage?: Usage,
  activity: AgentActivity = { reasoning: '', tools: [] }
): InteractionEditReplyOptions {
  const raw = parseJsonObject(response)
  const allowed = new Set([
    'content',
    'embeds',
    'components',
    'allowed_mentions',
    'allowedMentions',
    'attachments',
    'poll',
    'flags'
  ])
  for (const key of Object.keys(raw)) {
    if (!allowed.has(key)) throw new Error(`Unsupported Discord response field: ${key}`)
  }

  const payload = { ...raw } as Record<string, unknown>
  if ('allowed_mentions' in payload) {
    payload.allowedMentions = payload.allowed_mentions
    delete payload.allowed_mentions
  }
  if ('poll' in payload) payload.poll = normalizePoll(payload.poll)

  const { components, senderOnlyIds } = validateComponents(
    JSON.stringify(payload.components ?? []),
    token
  )
  ctx.components = components
  ctx.senderOnlyComponentIds = senderOnlyIds
  for (const triggerId of Object.keys(ctx.modals)) {
    if (!hasComponentId(components, `${GPT_ACTION_COMPONENT_ID}:${token}:${triggerId}`)) {
      delete ctx.modals[triggerId]
    }
  }
  const flags = typeof payload.flags === 'number' ? payload.flags : 0
  const usesComponentsV2 =
    (flags & MessageFlags.IsComponentsV2) !== 0 ||
    components.some((component) => component.type !== ComponentType.ActionRow)
  const footer = usageFooter(ctx.model, ctx.effort, ctx.maxTokens, usage)
  const activityText = formatAgentActivity(activity)

  if (usesComponentsV2) {
    const content = typeof payload.content === 'string' ? payload.content : ''
    const header: GptManagedComponent[] = [
      { type: ComponentType.TextDisplay, content: `**${ctx.displayPrompt}**` },
      { type: ComponentType.Separator, divider: true, spacing: SeparatorSpacingSize.Small }
    ]
    if (content) header.push({ type: ComponentType.TextDisplay, content })

    const activityComponents = activityText
      ? [{ type: ComponentType.TextDisplay, content: activityText }]
      : []
    if (header.length + components.length + activityComponents.length >= 10) {
      throw new Error(
        `At most ${9 - header.length - activityComponents.length} top-level response components may be used so the request prompt, divider, activity, and token footer can be appended.`
      )
    }
    components.unshift(...header)
    components.push(...activityComponents)
    components.push({ type: ComponentType.TextDisplay, content: footer })
    payload.content = null
    payload.embeds = []
    payload.components = components
    payload.flags = flags | MessageFlags.IsComponentsV2
  } else {
    payload.components = components
    const embeds = Array.isArray(payload.embeds)
      ? (structuredClone(payload.embeds) as Record<string, unknown>[])
      : []
    if (embeds.length > 0) {
      appendFooterToEmbed(embeds[embeds.length - 1]!, footer)
      payload.embeds = embeds
      if (activityText) {
        const content = typeof payload.content === 'string' ? payload.content : ''
        const separator = content ? '\n\n' : ''
        const available = Math.max(0, 2000 - activityText.length - separator.length)
        payload.content = `${content.slice(0, available)}${separator}${activityText}`
      }
    } else {
      const content = typeof payload.content === 'string' ? payload.content : ''
      const activity = activityText ? `\n\n${activityText}` : ''
      const separator = content ? '\n\n' : ''
      const available = Math.max(0, 2000 - activity.length - footer.length - separator.length)
      payload.content = `${content.slice(0, available)}${activity}${separator}${footer}`
    }
    payload.flags = flags & MessageFlags.SuppressEmbeds
  }

  return payload as InteractionEditReplyOptions
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
  managedComponents: GptManagedComponent[] = []
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

  components.push(...managedComponents)

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

interface StreamCallbacks {
  editMain: (components: GptComponent[]) => Promise<{ id?: string } | unknown>
  editPayload: (payload: InteractionEditReplyOptions) => Promise<{ id?: string } | unknown>
}

function makeCallbacks(
  interaction: {
    editReply: (options: { components: never; flags: number }) => Promise<unknown>
  },
  pub: boolean
): StreamCallbacks {
  void pub

  return {
    editMain: (comps) =>
      interaction.editReply({
        components: comps as never,
        flags: MessageFlags.IsComponentsV2
      }),
    editPayload: (payload) =>
      interaction.editReply({
        content: null,
        embeds: [],
        components: [],
        attachments: [],
        ...payload
      } as never)
  }
}

async function runGptStream(
  callbacks: StreamCallbacks,
  ctx: GptContext,
  token: string
): Promise<void> {
  const apiKey = process.env.OPENAI_API_KEY
  if (!apiKey) {
    await callbacks.editPayload(
      buildAgentPayload(JSON.stringify({ content: 'no OPENAI_API_KEY' }), token, ctx)
    )
    return
  }

  const existing = activeStreams.get(token)
  existing?.abort()

  const controller = new AbortController()
  activeStreams.set(token, controller)

  let responseContent = ''
  let usage: Usage | undefined
  const activity: AgentActivity = { reasoning: '', tools: [] }
  const mcpClients: McpClient[] = []

  try {
    const systemInstruction = [
      'Return the complete user-visible Discord message as one JSON object and no surrounding prose or Markdown fence. You may use content, embeds, components, allowed_mentions, attachments, poll, and flags from the Discord API. Use raw Discord API component objects and set flag 32768 for Components V2. Interactive custom_id values must be unique stable lowercase ids of 1-32 characters. Add sender_only: true to an interactive component when only the user who sent the original request should be allowed to use it; omit it or set it to false to allow everyone. Component interactions are sent back to you. The application appends token usage at the bottom, so do not add token statistics yourself. Use the manage_response_modals tool before your final JSON when a response button should open a modal.',
      hostedPageUrl()
        ? `The persistent single-file web page is hosted at ${hostedPageUrl()}. Use publish_html to create or replace it.`
        : 'Use publish_html to create or replace the persistent single-file web page. WEB_DOMAIN is not configured, so tell the user that its public URL is unavailable.',
      ctx.verbosity === 'brief'
        ? 'Be concise and to the point. Keep responses short.'
        : ctx.verbosity === 'detailed'
          ? 'Be thorough and comprehensive. Explain in detail.'
          : null
    ]
      .filter(Boolean)
      .join('\n')

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
    const googleCalendarConfiguration = await loadGoogleCalendarConfiguration()
    if (googleCalendarConfiguration) {
      mcpClients.push(
        new McpClient({
          applicationName: 'solver /a Google Calendar',
          transport: new StdioClientTransport({
            command: process.execPath,
            args: [GOOGLE_CALENDAR_MCP_PATH],
            env: getGoogleCalendarMcpEnvironment(googleCalendarConfiguration)
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
      const modalTool = interactionModalTool(token, ctx)
      const localTools = [
        publishHtmlTool,
        spotifyAuthenticationTool,
        googleCalendarAuthenticationTool,
        modalTool
      ]
      const agentTools = diagnosing
        ? localTools
        : replaceDuplicateTools([...localTools, ...(await loadMcpTools(mcpClients))])
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
          : systemInstruction,
        tools: agentTools,
        printer: false
      })

      for await (const event of agent.stream(prompt, {
        cancelSignal: controller.signal,
        limits: { turns: 8, outputTokens: ctx.maxTokens }
      })) {
        if (controller.signal.aborted) break

        if (event.type === 'modelStreamUpdateEvent') {
          if (event.event.type === 'modelContentBlockDeltaEvent') {
            if (event.event.delta.type === 'textDelta') {
              responseContent += event.event.delta.text
            } else if (
              event.event.delta.type === 'reasoningContentDelta' &&
              event.event.delta.text
            ) {
              activity.reasoning += event.event.delta.text
            } else if (
              event.event.delta.type === 'citationsDelta' &&
              event.event.delta.citations.length > 0 &&
              !activity.tools.some(({ id }) => id === 'web_search')
            ) {
              activity.tools.push({
                id: 'web_search',
                name: 'web_search',
                status: 'success'
              })
            }
          } else if (
            event.event.type === 'modelContentBlockStartEvent' &&
            event.event.start?.type === 'toolUseStart'
          ) {
            activity.tools.push({
              id: event.event.start.toolUseId,
              name: event.event.start.name,
              status: 'running'
            })
          }
        }
        if (event.type === 'toolResultEvent') {
          const usedTool = activity.tools.find(({ id }) => id === event.result.toolUseId)
          if (usedTool) usedTool.status = event.result.status
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

      responseContent = ''
      usage = undefined
      activity.reasoning = ''
      activity.tools = []
      const integrations = [
        'Docker MCP (`uvx mcp-server-docker`)',
        'Filesystem MCP',
        'Memory MCP',
        'Sequential Thinking MCP',
        'Fetch MCP',
        'Time MCP',
        'Playwright MCP',
        ...(spotifyConfiguration ? ['Spotify MCP'] : []),
        ...(googleCalendarConfiguration ? ['Google Calendar MCP'] : []),
        ...(mailApiKey ? ['Mail MCP'] : [])
      ].join(' and ')
      await streamAgent(
        `The original request was: ${ctx.prompt}\n\nThe agent encountered "MCP error -32000: Connection closed" while loading or using ${integrations}. Diagnose what likely went wrong and tell the user how to recover. If possible, also answer the original request without MCP tools.`,
        true
      )
    }

    if (!controller.signal.aborted) {
      const response = responseContent || '(no response)'
      await callbacks.editPayload(buildAgentPayload(response, token, ctx, usage, activity))
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
    await callbacks.editPayload(
      buildAgentPayload(JSON.stringify({ content: `error: ${errMsg}` }), token, ctx, usage)
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
      updatedCtx.components
    )
  )

  try {
    await runGptStream(callbacks, updatedCtx, token)
  } finally {
    if (updatedCtx.components.length === 0 && Object.keys(updatedCtx.modals).length === 0)
      deleteGptContext(token)
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

export function isGptActionComponentId(customId: string): boolean {
  return customId.startsWith(`${GPT_ACTION_COMPONENT_ID}:`)
}

export function isGptModalId(customId: string): boolean {
  return customId.startsWith(`${GPT_MODAL_ID}:`)
}

function hasComponentId(value: unknown, customId: string): boolean {
  if (Array.isArray(value)) return value.some((item) => hasComponentId(item, customId))
  if (!value || typeof value !== 'object') return false
  const component = value as Record<string, unknown>
  return (
    component.custom_id === customId ||
    Object.values(component).some((child) => hasComponentId(child, customId))
  )
}

async function rejectUnauthorizedGptInteraction(
  interaction: MessageComponentInteraction | ModalSubmitInteraction,
  ctx: GptContext,
  componentId: string
): Promise<boolean> {
  if (!ctx.senderOnlyComponentIds.includes(componentId) || interaction.user.id === ctx.userId) {
    return false
  }

  await interaction.reply(
    container('agent', new Map(), 'only the user who sent this request can use this component')
  )
  return true
}

export async function handleGptActionComponent(
  interaction: MessageComponentInteraction
): Promise<void> {
  const match = /^gpt-action:([^:]+):([a-z0-9_-]{1,32})$/.exec(interaction.customId)
  if (!match) return
  const token = match[1]!
  const componentId = match[2]!
  const ctx = loadGptContext(token)
  if (!ctx || !hasComponentId(ctx.components, interaction.customId)) {
    await interaction.reply(container('agent', new Map(), 'interaction expired'))
    return
  }
  if (await rejectUnauthorizedGptInteraction(interaction, ctx, componentId)) return

  const modal = ctx.modals[componentId]
  if (modal && interaction.isButton()) {
    await interaction.showModal(ModalBuilder.from(modal as never))
    return
  }

  await interaction.deferUpdate()
  await runInSession(ctx.userId, ctx.sessionName, async () => {
    ctx.history = loadConversation(ctx.userId, ctx.sessionName)
    const values = interaction.isAnySelectMenu() ? interaction.values : []
    ctx.prompt = JSON.stringify({
      type: 'discord_component',
      custom_id: componentId,
      values
    })
    storeGptContext(token, ctx)

    const callbacks = makeCallbacks(interaction, ctx.pub)
    await runGptStream(callbacks, ctx, token)
    if (ctx.components.length === 0 && Object.keys(ctx.modals).length === 0) deleteGptContext(token)
    else storeGptContext(token, ctx)
  })
}

export async function handleGptModalSubmit(interaction: ModalSubmitInteraction): Promise<void> {
  const match = /^gpt-modal:([^:]+):([a-z0-9_-]{1,32})$/.exec(interaction.customId)
  if (!match) return
  const token = match[1]!
  const triggerId = match[2]!
  const ctx = loadGptContext(token)
  if (!ctx || !ctx.modals[triggerId]) {
    await interaction.reply(container('agent', new Map(), 'interaction expired'))
    return
  }
  if (await rejectUnauthorizedGptInteraction(interaction, ctx, triggerId)) return

  const fields = [...interaction.fields.fields.values()].map((field) => {
    const value = field as unknown as Record<string, unknown>
    const attachments = value.attachments
    return {
      custom_id: field.customId,
      type: field.type,
      ...(typeof value.value === 'string' ||
      typeof value.value === 'boolean' ||
      value.value === null
        ? { value: value.value }
        : {}),
      ...(Array.isArray(value.values) ? { values: value.values } : {}),
      ...(attachments && typeof attachments === 'object' && 'map' in attachments
        ? {
            attachments: (
              attachments as {
                map: (callback: (item: { toJSON(): unknown }) => unknown) => unknown[]
              }
            ).map((attachment) => attachment.toJSON())
          }
        : {})
    }
  })

  await interaction.deferUpdate()
  await runInSession(ctx.userId, ctx.sessionName, async () => {
    ctx.history = loadConversation(ctx.userId, ctx.sessionName)
    ctx.prompt = JSON.stringify({ type: 'discord_modal_submit', trigger_id: triggerId, fields })
    storeGptContext(token, ctx)
    await runGptStream(makeCallbacks(interaction, ctx.pub), ctx, token)
    if (ctx.components.length === 0 && Object.keys(ctx.modals).length === 0) deleteGptContext(token)
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
    components: [],
    senderOnlyComponentIds: [],
    modals: {},
    expiresAt: Date.now() + GPT_INTERACTION_TTL_MS
  }

  await interaction.deferReply()

  await interaction.editReply({ content: '-# generating...' })

  const callbacks = makeCallbacks(interaction, pub)
  await runInSession(interaction.user.id, sessionName, async () => {
    ctx.history = loadConversation(interaction.user.id, sessionName)
    storeGptContext(token, ctx)
    try {
      await runGptStream(callbacks, ctx, token)
    } finally {
      if (ctx.components.length === 0 && Object.keys(ctx.modals).length === 0)
        deleteGptContext(token)
      else storeGptContext(token, ctx)
    }
  })
}
