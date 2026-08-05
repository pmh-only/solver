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
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { z } from 'zod'
import { errorContainer, matchesInteractiveId, PIN_BUTTON_ID } from '../components.js'
import { executeAgentShell, formatAgentShellResult } from '../helpers/agent-shell.js'
import {
  deleteStoredValue,
  getStoredValue,
  listStoredKeys,
  setStoredValue
} from '../helpers/kv-store.js'
import {
  loadStoredMcpServers,
  MAX_STORED_MCP_SERVERS,
  mcpServerNameSchema,
  removeStoredMcpServer,
  storedMcpServerSchema,
  type StoredMcpServer,
  upsertStoredMcpServer
} from '../helpers/mcp-store.js'
import { sharedPageUrl, writeSharedHtml } from '../hosted-page.js'
import { loadSystemPrompt } from '../system-prompt.js'
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
function shellTool(signal: AbortSignal) {
  return tool({
    name: 'shell',
    description:
      'Run an unrestricted Bash command in the application container as the agent user. The user has passwordless sudo access for commands that require root privileges.',
    inputSchema: z.object({
      command: z.string().min(1).describe('Complete Bash command to execute'),
      timeoutSeconds: z
        .number()
        .int()
        .min(1)
        .max(600)
        .default(600)
        .describe('Maximum execution time in seconds')
    }),
    callback: async ({ command, timeoutSeconds }) =>
      formatAgentShellResult(await executeAgentShell(command, timeoutSeconds * 1000, signal))
  })
}

function waitTool(signal: AbortSignal) {
  return tool({
    name: 'wait',
    description:
      'Pause this agent run for a bounded duration before continuing. Use when an external operation needs time to progress instead of repeatedly polling. The wait stops if the request is cancelled.',
    inputSchema: z.object({
      seconds: z
        .number()
        .min(0.1)
        .max(600)
        .describe('Number of seconds to wait, from 0.1 through 600')
    }),
    callback: async ({ seconds }) => {
      await delay(seconds * 1000, undefined, { signal })
      return `Waited ${seconds} second${seconds === 1 ? '' : 's'}.`
    }
  })
}

const publishHtmlTool = tool({
  name: 'publish_html',
  description:
    'Publish a complete single-file HTML page at a new unique /shared/<uuid> URL. Include all CSS and JavaScript in the HTML. Each published page persists across restarts.',
  inputSchema: z.object({
    html: z.string().describe('Complete HTML document to publish, up to 1 MiB')
  }),
  callback: async ({ html }) => {
    const id = await writeSharedHtml(html)
    const path = `/shared/${id}`
    const url = sharedPageUrl(id)
    return url
      ? `Published the persistent HTML page at ${url}`
      : `Published the persistent HTML page at ${path}. WEB_DOMAIN is not configured, so no public absolute URL is available.`
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

type EffortLevel = (typeof GPT_EFFORT_OPTIONS)[number]['id']
type VerbosityLevel = (typeof VERBOSITY_OPTIONS)[number]['id']

interface GptContext {
  prompt: string
  displayPrompt: string
  pub: boolean
  model: string
  effort: EffortLevel
  maxTokens: number
  verbosity: VerbosityLevel
  userId: string
  sessionName: string
  history: ConversationTurn[]
  modelHistory: MessageData[]
  components: GptManagedComponent[]
  senderOnlyComponentIds: string[]
  modals: Record<string, GptManagedComponent>
  expiresAt: number
}

type GptManagedComponent = Record<string, unknown>

interface ConversationTurn {
  role: 'user' | 'assistant'
  content: string
  webContent?: string
  status?: 'complete' | 'cancelled'
}

interface StoredConversation {
  version: 2
  turns: ConversationTurn[]
  messages: MessageData[]
}

interface AgentActivity {
  reasoning: string
  tools: Array<{ id: string; name: string; status: 'running' | 'success' | 'error' }>
  responseStarted: boolean
}

interface GptSessionSettings {
  model: string
  effort: EffortLevel
  maxTokens: number
}

const GPT_CONTEXT_KEY = 'gpt-ctx'
const GPT_SESSION_KEY = 'gpt-session'
const GPT_SELECTED_SESSION_KEY = 'gpt-session-selected'
const GPT_SETTINGS_KEY = 'gpt-settings'
const GPT_SESSIONS_KEY = 'gpt-sessions'
const GPT_WEB_SESSIONS_KEY = 'gpt-web-sessions'
const DEFAULT_SESSION_NAME = 'default'
const activeStreams = new Map<string, AbortController>()
const sessionQueues = new Map<string, Promise<void>>()
const activeWebInteractions = new Set<string>()

interface ActiveWebRun {
  id: string
  userId: string
  sessionName: string
  prompt: string
  startedAt: string
  controller: AbortController
  latestPayload: InteractionEditReplyOptions
  persisted: boolean
  done: Promise<void>
  finish: () => void
}

const activeWebRuns = new Map<string, ActiveWebRun>()

function isMcpConnectionClosed(error: unknown): boolean {
  let current = error
  for (let depth = 0; depth < 5 && current; depth++) {
    if (String(current).includes('MCP error -32000: Connection closed')) return true
    current = current instanceof Error ? current.cause : undefined
  }
  return false
}

function isToolInputJsonError(error: unknown): boolean {
  let current = error
  for (let depth = 0; depth < 5 && current; depth++) {
    if (String(current).toLowerCase().includes('unable to parse tool input json')) return true
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

async function loadMcpTools(
  clients: McpClient[],
  onLoaded?: (client: McpClient, tools: Tool[]) => void
): Promise<Tool[]> {
  const toolsByClient = await Promise.all(clients.map((client) => client.listTools()))
  clients.forEach((client, index) => onLoaded?.(client, toolsByClient[index]!))
  return toolsByClient.flat()
}

function storedMcpClient(server: StoredMcpServer): McpClient {
  const applicationName = `solver /a ${server.name}`
  if (server.transport === 'http') {
    return new McpClient({
      applicationName,
      transport: new StreamableHTTPClientTransport(
        new URL(server.url),
        server.headers ? { requestInit: { headers: server.headers } } : undefined
      )
    })
  }

  return new McpClient({
    applicationName,
    transport: new StdioClientTransport({
      command: server.command,
      ...(server.args ? { args: server.args } : {}),
      ...(server.env ? { env: server.env } : {}),
      ...(server.cwd ? { cwd: server.cwd } : {})
    })
  })
}

function publicMcpServer(server: StoredMcpServer): Record<string, unknown> {
  if (server.transport === 'http') {
    return {
      name: server.name,
      transport: server.transport,
      url: server.url,
      ...(server.headers ? { header_names: Object.keys(server.headers) } : {})
    }
  }
  return {
    name: server.name,
    transport: server.transport,
    command: server.command,
    ...(server.args ? { args: server.args } : {}),
    ...(server.env ? { env_names: Object.keys(server.env) } : {}),
    ...(server.cwd ? { cwd: server.cwd } : {})
  }
}

interface ManagedMcpConnection {
  client: McpClient
  tools: Tool[]
}

function mcpServerManagementTool(
  clients: McpClient[],
  managedConnections: Map<string, ManagedMcpConnection>,
  getAgent: () => Agent
) {
  return tool({
    name: 'manage_mcp_servers',
    description:
      'List, attach, replace, or remove MCP servers available to /a. The server list persists in the database. A successfully attached server and its tools are available immediately in this request. Use stdio with an executable command and separate args, or http for a Streamable HTTP MCP endpoint. Stored env and header values are redacted from list output.',
    inputSchema: z.object({
      action: z.enum(['list', 'attach', 'remove']),
      name: mcpServerNameSchema.optional().describe('Stable lowercase server id'),
      transport: z.enum(['stdio', 'http']).optional(),
      command: z.string().optional().describe('Executable for a stdio MCP server'),
      args: z.array(z.string()).optional().describe('Arguments for the stdio executable'),
      env: z.record(z.string(), z.string()).optional().describe('Environment for a stdio server'),
      cwd: z.string().optional().describe('Working directory for a stdio server'),
      url: z.string().optional().describe('Streamable HTTP MCP endpoint'),
      headers: z
        .record(z.string(), z.string())
        .optional()
        .describe('Request headers for an HTTP server')
    }),
    callback: async ({ action, name, transport, command, args, env, cwd, url, headers }) => {
      if (action === 'list') {
        const servers = loadStoredMcpServers().map(publicMcpServer)
        return servers.length === 0
          ? 'No persistent MCP servers are attached.'
          : JSON.stringify(servers)
      }
      if (!name) return 'name is required.'

      if (action === 'remove') {
        const removed = removeStoredMcpServer(name)
        const connection = managedConnections.get(name)
        if (connection) {
          const agent = getAgent()
          for (const registeredTool of connection.tools) {
            if (agent.toolRegistry.get(registeredTool.name) === registeredTool) {
              agent.toolRegistry.remove(registeredTool.name)
            }
          }
          managedConnections.delete(name)
          const clientIndex = clients.indexOf(connection.client)
          if (clientIndex !== -1) clients.splice(clientIndex, 1)
          await connection.client.disconnect().catch(() => {})
        }
        return removed ? `Removed MCP server ${name}.` : `MCP server ${name} was not attached.`
      }

      if (!transport) return 'transport is required when attaching a server.'
      const parsed = storedMcpServerSchema.safeParse(
        transport === 'http'
          ? { name, transport, url, headers }
          : { name, transport, command, args, env, cwd }
      )
      if (!parsed.success) return `Invalid MCP server: ${z.prettifyError(parsed.error)}`

      const server = parsed.data
      const storedServers = loadStoredMcpServers()
      if (
        storedServers.length >= MAX_STORED_MCP_SERVERS &&
        !storedServers.some(({ name: storedName }) => storedName === server.name)
      ) {
        return `At most ${MAX_STORED_MCP_SERVERS} MCP servers may be attached.`
      }
      const client = storedMcpClient(server)
      let serverTools: Tool[]
      try {
        serverTools = replaceDuplicateTools(await client.listTools())
      } catch (error) {
        await client.disconnect().catch(() => {})
        return `Could not attach MCP server ${name}: ${error instanceof Error ? error.message : String(error)}`
      }

      const agent = getAgent()
      const previous = managedConnections.get(name)
      if (previous) {
        for (const registeredTool of previous.tools) {
          if (agent.toolRegistry.get(registeredTool.name) === registeredTool) {
            agent.toolRegistry.remove(registeredTool.name)
          }
        }
      }
      for (const serverTool of serverTools) {
        const normalizedName = serverTool.name.replaceAll('-', '_')
        for (const registeredTool of agent.tools) {
          if (registeredTool.name.replaceAll('-', '_') === normalizedName) {
            agent.toolRegistry.remove(registeredTool.name)
          }
        }
      }
      agent.toolRegistry.addOrReplace(serverTools)
      upsertStoredMcpServer(server)

      if (previous) {
        const previousIndex = clients.indexOf(previous.client)
        if (previousIndex !== -1) clients.splice(previousIndex, 1)
        await previous.client.disconnect().catch(() => {})
      }
      clients.push(client)
      managedConnections.set(name, { client, tools: serverTools })
      const toolNames = serverTools.map(({ name: toolName }) => toolName)
      return `Attached MCP server ${name} with ${toolNames.length} tool${toolNames.length === 1 ? '' : 's'}${toolNames.length > 0 ? `: ${toolNames.join(', ')}` : ''}.`
    }
  })
}

type AnyRow = ActionRowBuilder<StringSelectMenuBuilder> | ActionRowBuilder<ButtonBuilder>

type GptComponent = ContainerBuilder | AnyRow | GptManagedComponent

function storeGptContext(token: string, ctx: GptContext) {
  setStoredValue(
    `${GPT_CONTEXT_KEY}:${token}`,
    JSON.stringify({ ...ctx, history: [], modelHistory: [] })
  )
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
    if (!Array.isArray(parsed.modelHistory)) parsed.modelHistory = []
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

function sessionsKey(userId: string): string {
  return `${GPT_SESSIONS_KEY}:${encodeURIComponent(userId)}`
}

function legacyWebSessionsKey(userId: string): string {
  return `${GPT_WEB_SESSIONS_KEY}:${encodeURIComponent(userId)}`
}

function addStoredSessionNames(sessions: Set<string>, stored: string | undefined): void {
  try {
    const names = JSON.parse(stored ?? '[]') as unknown
    if (!Array.isArray(names)) return
    for (const name of names) {
      if (typeof name === 'string' && name.trim() && name.length <= 100) sessions.add(name)
    }
  } catch {
    // Invalid indexes are rebuilt from valid persisted conversations.
  }
}

export function loadAgentSessionNames(userId: string): string[] {
  const sessions = new Set([DEFAULT_SESSION_NAME])
  addStoredSessionNames(sessions, getStoredValue(sessionsKey(userId)))
  addStoredSessionNames(sessions, getStoredValue(legacyWebSessionsKey(userId)))

  const prefix = `${GPT_SESSION_KEY}:${userId}:`
  for (const key of listStoredKeys()) {
    if (!key.startsWith(prefix)) continue
    try {
      const name = decodeURIComponent(key.slice(prefix.length))
      if (name.trim() && name.length <= 100) sessions.add(name)
    } catch {
      // Ignore malformed legacy keys.
    }
  }

  return [...sessions].sort((left, right) =>
    left === DEFAULT_SESSION_NAME
      ? -1
      : right === DEFAULT_SESSION_NAME
        ? 1
        : left.localeCompare(right)
  )
}

function registerAgentSession(userId: string, sessionName: string): void {
  const sessions = new Set(loadAgentSessionNames(userId))
  sessions.add(sessionName)
  setStoredValue(sessionsKey(userId), JSON.stringify([...sessions]))
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
      model: typeof model === 'string' && model.trim() ? model : defaults.model,
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

function validConversationTurns(value: unknown): value is ConversationTurn[] {
  return (
    Array.isArray(value) &&
    value.every(
      (turn) =>
        turn &&
        typeof turn === 'object' &&
        (turn.role === 'user' || turn.role === 'assistant') &&
        typeof turn.content === 'string' &&
        (turn.webContent === undefined || typeof turn.webContent === 'string') &&
        (turn.status === undefined || turn.status === 'complete' || turn.status === 'cancelled')
    )
  )
}

function validModelMessages(value: unknown): value is MessageData[] {
  return (
    Array.isArray(value) &&
    value.every(
      (message) =>
        message &&
        typeof message === 'object' &&
        (message.role === 'user' || message.role === 'assistant') &&
        Array.isArray(message.content)
    )
  )
}

function legacyAgentMessages(history: ConversationTurn[]): MessageData[] {
  return history.map((turn) => ({
    role: turn.role,
    content: [{ text: turn.content }]
  }))
}

function loadConversation(userId: string, sessionName: string): StoredConversation {
  const key = sessionKey(userId, sessionName)
  const stored = getStoredValue(key)
  if (stored === undefined) {
    setStoredValue(key, '[]')
    return { version: 2, turns: [], messages: [] }
  }

  try {
    const parsed = JSON.parse(stored) as unknown
    if (validConversationTurns(parsed)) {
      return { version: 2, turns: parsed, messages: legacyAgentMessages(parsed) }
    }
    if (
      parsed &&
      typeof parsed === 'object' &&
      (parsed as Partial<StoredConversation>).version === 2 &&
      validConversationTurns((parsed as Partial<StoredConversation>).turns) &&
      validModelMessages((parsed as Partial<StoredConversation>).messages)
    ) {
      return parsed as StoredConversation
    }
    return { version: 2, turns: [], messages: [] }
  } catch {
    return { version: 2, turns: [], messages: [] }
  }
}

function storeConversation(
  ctx: GptContext,
  response: string,
  messages: MessageData[],
  webContent?: string,
  status: ConversationTurn['status'] = 'complete'
): void {
  setStoredValue(
    sessionKey(ctx.userId, ctx.sessionName),
    JSON.stringify({
      version: 2,
      turns: [
        ...ctx.history,
        { role: 'user', content: ctx.prompt },
        {
          role: 'assistant',
          content: response,
          ...(webContent ? { webContent } : {}),
          ...(status !== 'complete' ? { status } : {})
        }
      ],
      messages
    } satisfies StoredConversation)
  )
}

function loadContextConversation(ctx: GptContext): void {
  const conversation = loadConversation(ctx.userId, ctx.sessionName)
  ctx.history = conversation.turns
  ctx.modelHistory = conversation.messages
}

function ensureTurnMessages(
  ctx: GptContext,
  messages: MessageData[],
  assistantText: string
): MessageData[] {
  const appendedMessages = messages.slice(ctx.modelHistory.length)
  if (!appendedMessages.some(({ role }) => role === 'user')) {
    return [
      ...ctx.modelHistory,
      { role: 'user', content: [{ text: ctx.prompt }] },
      { role: 'assistant', content: [{ text: assistantText }] }
    ]
  }
  if (messages.at(-1)?.role !== 'assistant') {
    return [...messages, { role: 'assistant', content: [{ text: assistantText }] }]
  }
  return messages
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
  if (activity.responseStarted) {
    const counts = new Map<string, number>()
    for (const { name } of activity.tools) counts.set(name, (counts.get(name) ?? 0) + 1)
    if (counts.size === 0) return ''
    return `-# (${[...counts].map(([name, count]) => `${name.replaceAll('`', '')} x${count}`).join(', ')})`
  }

  const sections: string[] = []
  const reasoning = activity.reasoning.trim()
  if (reasoning) {
    const limit = 1200
    sections.push(
      `**Reasoning**\n${reasoning.length > limit ? `${reasoning.slice(0, limit - 3)}...` : reasoning}`
    )
  }
  if (activity.tools.length > 0) {
    const tools = activity.tools.map(({ name, status }) => {
      const label = name.replaceAll('`', '')
      return `- \`${label}\`: ${status}`
    })
    sections.push(`**Tools used**\n${tools.join('\n')}`)
  }
  const summary = sections.join('\n\n')
  const limit = 3900
  return summary.length > limit ? `${summary.slice(0, limit - 3)}...` : summary
}

function agentPromptHeaderComponents(ctx: GptContext): GptManagedComponent[] {
  return [
    { type: ComponentType.TextDisplay, content: `**${ctx.displayPrompt}**` },
    { type: ComponentType.Separator, divider: true, spacing: SeparatorSpacingSize.Small }
  ]
}

function legacyAgentPromptHeader(ctx: GptContext): string {
  return `**${ctx.displayPrompt}**\n\n-# --------------------------------\n\n`
}

function buildAgentProgressPayload(
  ctx: GptContext,
  activity: AgentActivity = { reasoning: '', tools: [], responseStarted: false }
): InteractionEditReplyOptions {
  const activityText = formatAgentActivity(activity)
  return {
    content: null,
    embeds: [],
    components: [
      ...agentPromptHeaderComponents(ctx),
      ...(activityText
        ? [{ type: ComponentType.TextDisplay, content: activityText } as GptManagedComponent]
        : []),
      { type: ComponentType.TextDisplay, content: '-# generating...' }
    ] as never,
    flags: MessageFlags.IsComponentsV2,
    allowedMentions: { parse: [] }
  }
}

function buildAgentCancelledPayload(
  ctx: GptContext,
  activity: AgentActivity
): InteractionEditReplyOptions {
  const payload = buildAgentProgressPayload(ctx, activity)
  const components = payload.components as unknown as GptManagedComponent[]
  components[components.length - 1] = {
    type: ComponentType.TextDisplay,
    content: '-# cancelled'
  }
  return payload
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
  activity: AgentActivity = { reasoning: '', tools: [], responseStarted: false }
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
  const hasLegacyOnlyContent =
    (Array.isArray(payload.embeds) && payload.embeds.length > 0) || payload.poll != null
  const usesComponentsV2 =
    (flags & MessageFlags.IsComponentsV2) !== 0 ||
    components.some((component) => component.type !== ComponentType.ActionRow) ||
    !hasLegacyOnlyContent
  const footer = usageFooter(ctx.model, ctx.effort, ctx.maxTokens, usage)
  const activityText = formatAgentActivity(activity)

  if (usesComponentsV2) {
    const content = typeof payload.content === 'string' ? payload.content : ''
    const header = agentPromptHeaderComponents(ctx)
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
    const promptHeader = legacyAgentPromptHeader(ctx)
    const embeds = Array.isArray(payload.embeds)
      ? (structuredClone(payload.embeds) as Record<string, unknown>[])
      : []
    if (embeds.length > 0) {
      appendFooterToEmbed(embeds[embeds.length - 1]!, footer)
      payload.embeds = embeds
      const content = typeof payload.content === 'string' ? payload.content : ''
      const activity = activityText ? `\n\n${activityText}` : ''
      const available = Math.max(0, 2000 - promptHeader.length - activity.length)
      payload.content = `${promptHeader}${content.slice(0, available)}${activity}`
    } else {
      const content = typeof payload.content === 'string' ? payload.content : ''
      const activity = activityText ? `\n\n${activityText}` : ''
      const footerSection = `\n\n${footer}`
      const available = Math.max(
        0,
        2000 - promptHeader.length - activity.length - footerSection.length
      )
      payload.content = `${promptHeader}${content.slice(0, available)}${activity}${footerSection}`
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

  const components: GptComponent[] = [ctr]

  components.push(...managedComponents)

  if (!pub) {
    components.push(
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
          .setCustomId(PIN_BUTTON_ID)
          .setLabel('Pin')
          .setStyle(ButtonStyle.Secondary)
      ),
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
  stored?: () => void
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
  token: string,
  externalSignal?: AbortSignal
): Promise<void> {
  const apiKey = process.env.OPENAI_API_KEY
  if (!apiKey) {
    const response = JSON.stringify({ content: 'no OPENAI_API_KEY' })
    const payload = buildAgentPayload(response, token, ctx)
    await callbacks.editPayload(payload)
    storeConversation(
      ctx,
      response,
      ensureTurnMessages(ctx, ctx.modelHistory, 'no OPENAI_API_KEY'),
      JSON.stringify(payload)
    )
    callbacks.stored?.()
    return
  }

  const existing = activeStreams.get(token)
  existing?.abort()

  const controller = new AbortController()
  const abort = () => controller.abort()
  if (externalSignal?.aborted) controller.abort()
  else externalSignal?.addEventListener('abort', abort, { once: true })
  activeStreams.set(token, controller)

  let responseContent = ''
  let usage: Usage | undefined
  let modelMessages = ctx.modelHistory
  let conversationStored = false
  const activity: AgentActivity = { reasoning: '', tools: [], responseStarted: false }
  const mcpClients: McpClient[] = []
  const managedMcpConnections = new Map<string, ManagedMcpConnection>()
  let lastProgressUpdate = 0
  let lastProgressPayload = ''

  const updateProgress = async (force = false): Promise<void> => {
    const payload = buildAgentProgressPayload(ctx, activity)
    const serializedPayload = JSON.stringify(payload)
    const now = Date.now()
    if (serializedPayload === lastProgressPayload || (!force && now - lastProgressUpdate < 1000))
      return
    await callbacks.editPayload(payload)
    lastProgressPayload = serializedPayload
    lastProgressUpdate = now
  }

  try {
    await updateProgress(true)
    const systemInstruction = [
      loadSystemPrompt(),
      'Return the complete user-visible Discord message as one JSON object and no surrounding prose or Markdown fence. You may use content, embeds, components, allowed_mentions, attachments, poll, and flags from the Discord API. Use raw Discord API component objects and set flag 32768 for Components V2. Interactive custom_id values must be unique stable lowercase ids of 1-32 characters. Add sender_only: true to an interactive component when only the user who sent the original request should be allowed to use it; omit it or set it to false to allow everyone. Component interactions are sent back to you. The application appends token usage at the bottom, so do not add token statistics yourself. Use the manage_response_modals tool before your final JSON when a response button should open a modal.',
      'Use manage_mcp_servers to list, attach, replace, or remove persistent MCP servers when needed. Tools from a successfully attached server are available immediately in the current request.',
      'When using the coding agent, submit the request once and avoid repeatedly polling for status unless there is a concrete need to check.',
      process.env.WEB_DOMAIN?.trim()
        ? 'Use publish_html to create a persistent single-file web page at a new unique URL under the configured web domain.'
        : 'Use publish_html to create a persistent single-file web page at a new unique /shared/<uuid> path. WEB_DOMAIN is not configured, so tell the user that its public absolute URL is unavailable.',
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
        ...(ctx.effort !== 'none' ? { reasoning: { effort: ctx.effort, summary: 'auto' } } : {})
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
          args: ['--with', 'mcp==1.29.0', 'mcp-server-fetch==2026.7.10']
        })
      }),
      new McpClient({
        applicationName: 'solver /a Time',
        transport: new StdioClientTransport({
          command: 'uvx',
          args: ['--with', 'mcp==1.29.0', 'mcp-server-time==2026.7.10']
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
    for (const server of loadStoredMcpServers()) {
      const client = storedMcpClient(server)
      mcpClients.push(client)
      managedMcpConnections.set(server.name, { client, tools: [] })
    }
    const streamAgent = async (prompt: string, diagnosing = false, retryingToolInput = false) => {
      const modalTool = interactionModalTool(token, ctx)
      let agent: Agent
      const manageMcpServersTool = mcpServerManagementTool(
        mcpClients,
        managedMcpConnections,
        () => agent
      )
      const localTools = [
        shellTool(controller.signal),
        waitTool(controller.signal),
        publishHtmlTool,
        spotifyAuthenticationTool,
        googleCalendarAuthenticationTool,
        manageMcpServersTool,
        modalTool
      ]
      const agentTools = diagnosing
        ? localTools
        : replaceDuplicateTools([
            ...localTools,
            ...(await loadMcpTools(mcpClients, (client, tools) => {
              for (const connection of managedMcpConnections.values()) {
                if (connection.client === client) connection.tools = tools
              }
            }))
          ])
      agent = new Agent({
        model,
        messages: ctx.modelHistory,
        systemPrompt: diagnosing
          ? [
              systemInstruction,
              'Diagnose the reported MCP connection failure for the user. Explain the likely cause and concrete recovery checks. Do not claim to have run checks or use MCP tools, because those clients disconnected.'
            ]
              .filter(Boolean)
              .join('\n')
          : [
              systemInstruction,
              retryingToolInput
                ? 'The previous attempt produced malformed tool input. Retry the request, ensuring every tool input is one complete valid JSON object that exactly matches its schema.'
                : null
            ]
              .filter(Boolean)
              .join('\n'),
        tools: agentTools,
        printer: false
      })
      let contentBlockStarted = false

      try {
        for await (const event of agent.stream(prompt, { cancelSignal: controller.signal })) {
          if (controller.signal.aborted) break

          let activityChanged = false
          let forceProgressUpdate = false

          if (event.type === 'modelStreamUpdateEvent') {
            if (event.event.type === 'modelContentBlockDeltaEvent') {
              if (event.event.delta.type === 'textDelta') {
                contentBlockStarted = false
                if (!activity.responseStarted) {
                  activity.responseStarted = true
                  activityChanged = true
                  forceProgressUpdate = true
                }
                responseContent += event.event.delta.text
              } else if (
                event.event.delta.type === 'reasoningContentDelta' &&
                event.event.delta.text
              ) {
                if (contentBlockStarted) activity.reasoning = ''
                contentBlockStarted = false
                if (!activity.reasoning || activity.responseStarted) forceProgressUpdate = true
                activity.responseStarted = false
                activity.reasoning += event.event.delta.text
                activityChanged = true
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
                activityChanged = true
                forceProgressUpdate = true
              }
            } else if (event.event.type === 'modelContentBlockStartEvent') {
              if (event.event.start?.type === 'toolUseStart') {
                contentBlockStarted = false
                activity.tools.push({
                  id: event.event.start.toolUseId,
                  name: event.event.start.name,
                  status: 'running'
                })
                activityChanged = true
                forceProgressUpdate = true
              } else {
                contentBlockStarted = true
              }
            }
          }
          if (event.type === 'toolResultEvent') {
            const usedTool = activity.tools.find(({ id }) => id === event.result.toolUseId)
            if (usedTool) {
              usedTool.status = event.result.status
              activityChanged = true
              forceProgressUpdate = true
            }
          }
          if (event.type === 'agentResultEvent') {
            usage = event.result.metrics?.latestAgentInvocation?.usage
          }
          if (activityChanged) await updateProgress(forceProgressUpdate)
        }
      } finally {
        modelMessages = agent.messages.map((message) => message.toJSON())
        if (diagnosing) {
          const userMessage = modelMessages[ctx.modelHistory.length]
          if (userMessage?.role === 'user') userMessage.content = [{ text: ctx.prompt }]
        }
      }
    }

    try {
      try {
        await streamAgent(ctx.prompt)
      } catch (error) {
        if (!isToolInputJsonError(error) || controller.signal.aborted) throw error
        for (const usedTool of activity.tools) {
          if (usedTool.status === 'running') usedTool.status = 'error'
        }
        await updateProgress(true)
        responseContent = ''
        usage = undefined
        await streamAgent(ctx.prompt, false, true)
      }
    } catch (error) {
      if (!isMcpConnectionClosed(error) || controller.signal.aborted) throw error

      responseContent = ''
      usage = undefined
      activity.reasoning = ''
      activity.tools = []
      activity.responseStarted = false
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
        ...(mailApiKey ? ['Mail MCP'] : []),
        ...loadStoredMcpServers().map(({ name }) => `${name} MCP`)
      ].join(' and ')
      await streamAgent(
        `The original request was: ${ctx.prompt}\n\nThe agent encountered "MCP error -32000: Connection closed" while loading or using ${integrations}. Diagnose what likely went wrong and tell the user how to recover. If possible, also answer the original request without MCP tools.`,
        true
      )
    }

    if (!controller.signal.aborted) {
      const response = responseContent || JSON.stringify({ content: '(no response)' })
      const payload = buildAgentPayload(response, token, ctx, usage, activity)
      await callbacks.editPayload(payload)
      storeConversation(ctx, response, modelMessages, JSON.stringify(payload))
      conversationStored = true
      callbacks.stored?.()
    }
  } catch (error) {
    if (
      error instanceof Error &&
      (error.name === 'AbortError' || error.message.includes('abort'))
    ) {
      return
    }

    const errMsg = error instanceof Error ? error.message : 'unknown error'
    for (const usedTool of activity.tools) {
      if (usedTool.status === 'running') usedTool.status = 'error'
    }
    const response = JSON.stringify({ content: `error: ${errMsg}` })
    const payload = buildAgentPayload(response, token, ctx, usage, activity)
    await callbacks.editPayload(payload)
    storeConversation(
      ctx,
      response,
      ensureTurnMessages(ctx, modelMessages, `error: ${errMsg}`),
      JSON.stringify(payload)
    )
    conversationStored = true
    callbacks.stored?.()
  } finally {
    if (controller.signal.aborted && !conversationStored) {
      modelMessages = ensureTurnMessages(ctx, modelMessages, 'Cancelled by user')
      const payload = buildAgentCancelledPayload(ctx, activity)
      storeConversation(
        ctx,
        JSON.stringify({ content: 'Cancelled by user' }),
        modelMessages,
        JSON.stringify(payload),
        'cancelled'
      )
      callbacks.stored?.()
      await callbacks.editPayload(payload).catch(() => {})
    }
    externalSignal?.removeEventListener('abort', abort)
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
    await interaction.reply(errorContainer('gpt', new Map(), 'session expired'))
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

async function continueGptComponentInteraction(
  ctx: GptContext,
  token: string,
  componentId: string,
  values: string[],
  callbacks: StreamCallbacks,
  signal?: AbortSignal
): Promise<void> {
  await runInSession(ctx.userId, ctx.sessionName, async () => {
    loadContextConversation(ctx)
    ctx.prompt = JSON.stringify({
      type: 'discord_component',
      custom_id: componentId,
      values
    })
    storeGptContext(token, ctx)
    try {
      await runGptStream(callbacks, ctx, token, signal)
    } finally {
      if (ctx.components.length === 0 && Object.keys(ctx.modals).length === 0)
        deleteGptContext(token)
      else storeGptContext(token, ctx)
    }
  })
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

function findComponent(value: unknown, customId: string): GptManagedComponent | null {
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findComponent(item, customId)
      if (found) return found
    }
    return null
  }
  if (!value || typeof value !== 'object') return null
  const component = value as GptManagedComponent
  if (component.custom_id === customId) return component
  for (const child of Object.values(component)) {
    const found = findComponent(child, customId)
    if (found) return found
  }
  return null
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
    errorContainer('agent', new Map(), 'only the user who sent this request can use this component')
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
    await interaction.reply(errorContainer('agent', new Map(), 'interaction expired'))
    return
  }
  if (await rejectUnauthorizedGptInteraction(interaction, ctx, componentId)) return

  const modal = ctx.modals[componentId]
  if (modal && interaction.isButton()) {
    await interaction.showModal(ModalBuilder.from(modal as never))
    return
  }

  await interaction.deferUpdate()
  await continueGptComponentInteraction(
    ctx,
    token,
    componentId,
    interaction.isAnySelectMenu() ? interaction.values : [],
    makeCallbacks(interaction, ctx.pub)
  )
}

export async function handleGptModalSubmit(interaction: ModalSubmitInteraction): Promise<void> {
  const match = /^gpt-modal:([^:]+):([a-z0-9_-]{1,32})$/.exec(interaction.customId)
  if (!match) return
  const token = match[1]!
  const triggerId = match[2]!
  const ctx = loadGptContext(token)
  if (!ctx || !ctx.modals[triggerId]) {
    await interaction.reply(errorContainer('agent', new Map(), 'interaction expired'))
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
    loadContextConversation(ctx)
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
  registerAgentSession(interaction.user.id, sessionName)

  if (prompt === '/clear') {
    await interaction.deferReply()
    await runInSession(interaction.user.id, sessionName, async () => {
      setStoredValue(sessionKey(interaction.user.id, sessionName), '[]')
      await interaction.editReply({
        content: null,
        components: [
          { type: ComponentType.TextDisplay, content: '**/clear**' },
          { type: ComponentType.Separator, divider: true, spacing: SeparatorSpacingSize.Small },
          {
            type: ComponentType.TextDisplay,
            content: `Cleared history for session \`${footerSessionName(sessionName)}\`.`
          }
        ] as never,
        flags: MessageFlags.IsComponentsV2,
        allowedMentions: { parse: [] }
      })
    })
    return
  }

  loadConversation(interaction.user.id, sessionName)

  const storedSettings = loadSessionSettings(interaction.user.id, sessionName)
  const requestedModel = interaction.options.getString('model')
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
    modelHistory: [],
    components: [],
    senderOnlyComponentIds: [],
    modals: {},
    expiresAt: Date.now() + GPT_INTERACTION_TTL_MS
  }

  await interaction.deferReply()

  await interaction.editReply(buildAgentProgressPayload(ctx))

  const callbacks = makeCallbacks(interaction, pub)
  await runInSession(interaction.user.id, sessionName, async () => {
    loadContextConversation(ctx)
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

export interface WebAgentRequest {
  userId: string
  prompt: string
  sessionName?: string
  model?: string
  effort?: string
  maxTokens?: number
  runId?: string
}

export interface WebInteractionField {
  custom_id: string
  type: number
  value?: string | boolean | null
  values?: string[]
}

export interface WebInteractionRequest {
  userId: string
  customId: string
  values?: string[]
  fields?: WebInteractionField[]
}

export type WebInteractionResult = { modal: GptManagedComponent } | { updated: true }

export interface WebConversationTurn {
  role: 'user' | 'assistant'
  content: string
  status?: 'running' | 'cancelled'
  runId?: string
  startedAt?: string
}

export interface WebSessionState {
  sessions: string[]
  settings: GptSessionSettings
}

function validateWebSessionName(sessionName: string): string {
  const name = sessionName.trim()
  if (!name) throw new Error('Session name must not be empty')
  if (name.length > 100) throw new Error('Session name must not exceed 100 characters')
  return name
}

export function loadWebSessionState(
  userId: string,
  sessionName = DEFAULT_SESSION_NAME
): WebSessionState {
  const name = validateWebSessionName(sessionName)
  return {
    sessions: loadAgentSessionNames(userId),
    settings: loadSessionSettings(userId, name)
  }
}

export function createWebSession(userId: string, sessionName: string): WebSessionState {
  const name = validateWebSessionName(sessionName)
  loadConversation(userId, name)
  registerAgentSession(userId, name)
  return loadWebSessionState(userId, name)
}

export function loadWebConversation(
  userId: string,
  sessionName = DEFAULT_SESSION_NAME
): WebConversationTurn[] {
  const visible: WebConversationTurn[] = []
  const name = validateWebSessionName(sessionName)
  for (const { role, content, webContent, status } of loadConversation(userId, name).turns) {
    let interaction = false
    if (role === 'user') {
      try {
        const parsed = JSON.parse(content) as { type?: unknown }
        interaction = parsed.type === 'discord_component' || parsed.type === 'discord_modal_submit'
      } catch {
        // Ordinary user messages are not JSON interaction envelopes.
      }
    }
    if (interaction) {
      if (visible.at(-1)?.role === 'assistant') visible.pop()
      continue
    }
    visible.push({
      role,
      content: role === 'assistant' ? (webContent ?? content) : content,
      ...(status === 'cancelled' ? { status } : {})
    })
  }
  const active = activeWebRuns.get(sessionKey(userId, name))
  if (active && !active.persisted) {
    visible.push(
      { role: 'user', content: active.prompt, status: 'running', runId: active.id },
      {
        role: 'assistant',
        content: JSON.stringify(active.latestPayload),
        status: 'running',
        runId: active.id,
        startedAt: active.startedAt
      }
    )
  }
  return visible
}

export async function cancelWebAgent(
  userId: string,
  sessionName = DEFAULT_SESSION_NAME,
  runId?: string
): Promise<boolean> {
  const name = validateWebSessionName(sessionName)
  const active = activeWebRuns.get(sessionKey(userId, name))
  if (!active || (runId && active.id !== runId)) return false
  active.controller.abort()
  await active.done
  return true
}

export async function clearWebConversation(
  userId: string,
  sessionName = DEFAULT_SESSION_NAME
): Promise<void> {
  const name = validateWebSessionName(sessionName)
  await cancelWebAgent(userId, name)
  await runInSession(userId, name, async () => {
    setStoredValue(sessionKey(userId, name), '[]')
  })
}

export async function runWebAgent(
  request: WebAgentRequest,
  onUpdate: (payload: InteractionEditReplyOptions) => Promise<void>,
  signal?: AbortSignal
): Promise<void> {
  const prompt = request.prompt.trim()
  if (!prompt || prompt.length > 32_000)
    throw new Error('Prompt must contain 1 to 32,000 characters')
  const sessionName = request.sessionName?.trim() || DEFAULT_SESSION_NAME
  if (sessionName.length > 100) throw new Error('Session name must not exceed 100 characters')
  const runId = request.runId ?? randomUUID()
  if (!/^[a-zA-Z0-9-]{1,64}$/.test(runId)) throw new Error('Invalid run identifier')

  const storedSettings = loadSessionSettings(request.userId, sessionName)
  const effort = request.effort ?? storedSettings.effort
  if (!GPT_EFFORT_OPTIONS.some(({ id }) => id === effort))
    throw new Error('Invalid reasoning effort')
  const maxTokens = request.maxTokens ?? storedSettings.maxTokens
  if (!Number.isInteger(maxTokens) || maxTokens < 256 || maxTokens > 16_384) {
    throw new Error('Token limit must be an integer between 256 and 16384')
  }
  const settings: GptSessionSettings = {
    model: request.model?.trim() || storedSettings.model,
    effort: effort as EffortLevel,
    maxTokens
  }
  if (settings.model.length > 200) throw new Error('Model must not exceed 200 characters')
  storeSessionSettings(request.userId, sessionName, settings)
  registerAgentSession(request.userId, sessionName)

  const token = randomUUID().replace(/-/g, '').slice(0, 16)
  const ctx: GptContext = {
    prompt,
    displayPrompt: prompt,
    pub: true,
    model: settings.model,
    effort: settings.effort,
    maxTokens: settings.maxTokens,
    verbosity: 'normal',
    userId: request.userId,
    sessionName,
    history: [],
    modelHistory: [],
    components: [],
    senderOnlyComponentIds: [],
    modals: {},
    expiresAt: Date.now() + GPT_INTERACTION_TTL_MS
  }
  const key = sessionKey(request.userId, sessionName)
  activeWebRuns.get(key)?.controller.abort()
  const controller = new AbortController()
  const abort = () => controller.abort()
  if (signal?.aborted) controller.abort()
  else signal?.addEventListener('abort', abort, { once: true })
  let finish!: () => void
  const done = new Promise<void>((resolve) => {
    finish = resolve
  })
  const active: ActiveWebRun = {
    id: runId,
    userId: request.userId,
    sessionName,
    prompt,
    startedAt: new Date().toISOString(),
    controller,
    latestPayload: buildAgentProgressPayload(ctx),
    persisted: false,
    done,
    finish
  }
  activeWebRuns.set(key, active)
  const update = async (payload: InteractionEditReplyOptions): Promise<void> => {
    active.latestPayload = payload
    await onUpdate(payload)
  }
  const callbacks: StreamCallbacks = {
    editMain: async (components) =>
      update({
        content: null,
        components: components as never,
        flags: MessageFlags.IsComponentsV2
      }),
    editPayload: update,
    stored: () => {
      active.persisted = true
    }
  }

  try {
    await runInSession(request.userId, sessionName, async () => {
      loadContextConversation(ctx)
      storeGptContext(token, ctx)
      try {
        await runGptStream(callbacks, ctx, token, controller.signal)
      } finally {
        if (ctx.components.length === 0 && Object.keys(ctx.modals).length === 0)
          deleteGptContext(token)
        else storeGptContext(token, ctx)
      }
    })
  } finally {
    signal?.removeEventListener('abort', abort)
    if (activeWebRuns.get(key) === active) activeWebRuns.delete(key)
    active.finish()
  }
}

function webCallbacks(
  onUpdate: (payload: InteractionEditReplyOptions) => Promise<void>
): StreamCallbacks {
  return {
    editMain: async (components) =>
      onUpdate({
        content: null,
        components: components as never,
        flags: MessageFlags.IsComponentsV2
      }),
    editPayload: onUpdate
  }
}

function webInteractionError(message: string): never {
  const error = new Error(message)
  error.name = 'WebInteractionError'
  throw error
}

function parseWebInteractionId(customId: string): {
  kind: 'component' | 'modal'
  token: string
  stableId: string
} {
  const match = /^(gpt-action|gpt-modal):([^:]+):([a-z0-9_-]{1,32})$/.exec(customId)
  if (!match) webInteractionError('Invalid interaction identifier')
  return {
    kind: match[1] === GPT_MODAL_ID ? 'modal' : 'component',
    token: match[2]!,
    stableId: match[3]!
  }
}

function modalFields(value: unknown): GptManagedComponent[] {
  if (Array.isArray(value)) return value.flatMap(modalFields)
  if (!value || typeof value !== 'object') return []
  const component = value as GptManagedComponent
  const own = typeof component.custom_id === 'string' ? [component] : []
  return own.concat(modalFields(component.components), modalFields(component.component))
}

function normalizeWebModalFields(
  modal: GptManagedComponent,
  submitted: WebInteractionField[] | undefined
): WebInteractionField[] {
  if (!Array.isArray(submitted) || submitted.length > 25) {
    webInteractionError('Invalid modal fields')
  }
  const definitions = new Map(
    modalFields(modal)
      .filter((field) => field.custom_id !== modal.custom_id)
      .map((field) => [field.custom_id as string, field])
  )
  const seen = new Set<string>()
  const fields = submitted.map((field) => {
    if (!field || typeof field !== 'object' || seen.has(field.custom_id)) {
      webInteractionError('Invalid modal fields')
    }
    const definition = definitions.get(field.custom_id)
    if (!definition || definition.type !== field.type) webInteractionError('Invalid modal fields')
    seen.add(field.custom_id)
    if (field.type === ComponentType.TextInput) {
      if (typeof field.value !== 'string') webInteractionError('Invalid modal fields')
      const min =
        typeof definition.min_length === 'number'
          ? definition.min_length
          : definition.required === false
            ? 0
            : 1
      const max = typeof definition.max_length === 'number' ? definition.max_length : 4000
      if (field.value.length < min || field.value.length > max) {
        webInteractionError('Modal field validation failed')
      }
      return { custom_id: field.custom_id, type: field.type, value: field.value }
    }
    if (field.type === ComponentType.RadioGroup) {
      if (typeof field.value !== 'string' && field.value !== null) {
        webInteractionError('Invalid modal fields')
      }
      if (definition.required !== false && field.value === null) {
        webInteractionError('Modal field validation failed')
      }
      const allowed = new Set(
        Array.isArray(definition.options)
          ? definition.options.flatMap((option) =>
              option && typeof option === 'object' && typeof option.value === 'string'
                ? [option.value]
                : []
            )
          : []
      )
      if (typeof field.value === 'string' && !allowed.has(field.value)) {
        webInteractionError('Modal field validation failed')
      }
      return { custom_id: field.custom_id, type: field.type, value: field.value }
    }
    if (
      field.type === ComponentType.StringSelect ||
      field.type === ComponentType.UserSelect ||
      field.type === ComponentType.RoleSelect ||
      field.type === ComponentType.MentionableSelect ||
      field.type === ComponentType.ChannelSelect ||
      field.type === ComponentType.CheckboxGroup
    ) {
      if (!Array.isArray(field.values) || !field.values.every((item) => typeof item === 'string')) {
        webInteractionError('Invalid modal fields')
      }
      const min =
        typeof definition.min_values === 'number'
          ? definition.min_values
          : definition.required === false
            ? 0
            : 1
      const max =
        typeof definition.max_values === 'number'
          ? definition.max_values
          : field.type === ComponentType.CheckboxGroup && Array.isArray(definition.options)
            ? definition.options.length
            : 1
      if (
        field.values.length < min ||
        field.values.length > max ||
        new Set(field.values).size !== field.values.length ||
        field.values.some((value) => value.length > 100)
      ) {
        webInteractionError('Modal field validation failed')
      }
      if (field.type === ComponentType.StringSelect || field.type === ComponentType.CheckboxGroup) {
        const allowed = new Set(
          Array.isArray(definition.options)
            ? definition.options.flatMap((option) =>
                option && typeof option === 'object' && typeof option.value === 'string'
                  ? [option.value]
                  : []
              )
            : []
        )
        if (!field.values.every((value) => allowed.has(value))) {
          webInteractionError('Modal field validation failed')
        }
      } else if (!field.values.every((value) => /^\d{17,20}$/.test(value))) {
        webInteractionError('Modal field validation failed')
      }
      return { custom_id: field.custom_id, type: field.type, values: field.values }
    }
    if (field.type === ComponentType.Checkbox) {
      if (typeof field.value !== 'boolean') webInteractionError('Invalid modal fields')
      return { custom_id: field.custom_id, type: field.type, value: field.value }
    }
    webInteractionError('Unsupported modal field type')
  })
  for (const definition of definitions.values()) {
    if (definition.required !== false && !seen.has(definition.custom_id as string)) {
      webInteractionError('Modal field validation failed')
    }
  }
  return fields
}

function validateWebComponentValues(component: GptManagedComponent, values: string[]): void {
  if (component.disabled === true) webInteractionError('Interaction is disabled')
  const type = component.type as ComponentType
  if (type === ComponentType.Button) {
    if (values.length !== 0) webInteractionError('Invalid interaction values')
    return
  }
  const selectTypes = new Set<ComponentType>([
    ComponentType.StringSelect,
    ComponentType.UserSelect,
    ComponentType.RoleSelect,
    ComponentType.MentionableSelect,
    ComponentType.ChannelSelect
  ])
  if (!selectTypes.has(type)) webInteractionError('Unsupported interaction component')
  const min = typeof component.min_values === 'number' ? component.min_values : 1
  const max = typeof component.max_values === 'number' ? component.max_values : 1
  if (values.length < min || values.length > max || new Set(values).size !== values.length) {
    webInteractionError('Invalid interaction values')
  }
  if (type === ComponentType.StringSelect) {
    const allowed = new Set(
      Array.isArray(component.options)
        ? component.options.flatMap((option) =>
            option && typeof option === 'object' && typeof option.value === 'string'
              ? [option.value]
              : []
          )
        : []
    )
    if (!values.every((value) => allowed.has(value)))
      webInteractionError('Invalid interaction values')
  } else if (!values.every((value) => /^\d{17,20}$/.test(value))) {
    webInteractionError('Invalid interaction values')
  }
}

export async function runWebInteraction(
  request: WebInteractionRequest,
  onUpdate: (payload: InteractionEditReplyOptions) => Promise<void>,
  signal?: AbortSignal
): Promise<WebInteractionResult> {
  const parsed = parseWebInteractionId(request.customId)
  let ctx = loadGptContext(parsed.token)
  if (!ctx) webInteractionError('Interaction expired')
  if (ctx.senderOnlyComponentIds.includes(parsed.stableId) && request.userId !== ctx.userId) {
    webInteractionError('Only the user who sent this request can use this component')
  }
  if (request.userId !== ctx.userId) {
    webInteractionError('This interaction belongs to another user')
  }
  const interactionKey = `${request.userId}:${request.customId}`
  if (activeWebInteractions.has(interactionKey))
    webInteractionError('Interaction already in progress')
  activeWebInteractions.add(interactionKey)
  try {
    if (parsed.kind === 'component') {
      const component = findComponent(ctx.components, request.customId)
      if (!component) webInteractionError('Interaction expired')
      const modal = ctx.modals[parsed.stableId]
      if (modal && component.type === ComponentType.Button) return { modal }
      const values = request.values ?? []
      if (
        !Array.isArray(values) ||
        values.length > 25 ||
        !values.every((value) => typeof value === 'string' && value.length <= 100)
      ) {
        webInteractionError('Invalid interaction values')
      }
      validateWebComponentValues(component, values)
      await runInSession(ctx.userId, ctx.sessionName, async () => {
        const latest = loadGptContext(parsed.token)
        const latestComponent = latest && findComponent(latest.components, request.customId)
        if (!latest || !latestComponent) webInteractionError('Interaction expired')
        ctx = latest
        validateWebComponentValues(latestComponent, values)
        loadContextConversation(ctx)
        ctx.prompt = JSON.stringify({
          type: 'discord_component',
          custom_id: parsed.stableId,
          values
        })
        storeGptContext(parsed.token, ctx)
        await runGptStream(webCallbacks(onUpdate), ctx, parsed.token, signal)
        if (ctx.components.length === 0 && Object.keys(ctx.modals).length === 0)
          deleteGptContext(parsed.token)
        else storeGptContext(parsed.token, ctx)
      })
      return { updated: true }
    }

    const modal = ctx.modals[parsed.stableId]
    if (!modal || modal.custom_id !== request.customId) webInteractionError('Interaction expired')
    const fields = normalizeWebModalFields(modal, request.fields)
    await runInSession(ctx.userId, ctx.sessionName, async () => {
      const latest = loadGptContext(parsed.token)
      const latestModal = latest?.modals[parsed.stableId]
      if (!latest || !latestModal || latestModal.custom_id !== request.customId) {
        webInteractionError('Interaction expired')
      }
      ctx = latest
      normalizeWebModalFields(latestModal, request.fields)
      loadContextConversation(ctx)
      ctx.prompt = JSON.stringify({
        type: 'discord_modal_submit',
        trigger_id: parsed.stableId,
        fields
      })
      storeGptContext(parsed.token, ctx)
      await runGptStream(webCallbacks(onUpdate), ctx, parsed.token, signal)
      if (ctx.components.length === 0 && Object.keys(ctx.modals).length === 0)
        deleteGptContext(parsed.token)
      else storeGptContext(parsed.token, ctx)
    })
    return { updated: true }
  } finally {
    activeWebInteractions.delete(interactionKey)
  }
}

export interface WebComponentInteractionRequest {
  userId: string
  customId: string
  values?: string[]
}

export async function runWebComponentInteraction(
  request: WebComponentInteractionRequest,
  onUpdate: (payload: InteractionEditReplyOptions) => Promise<void>,
  signal?: AbortSignal
): Promise<void> {
  const result = await runWebInteraction(request, onUpdate, signal)
  if ('modal' in result) throw new Error('This component requires a Web modal')
}
