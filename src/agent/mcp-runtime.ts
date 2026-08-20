import {
  Agent,
  McpClient,
  tool,
  type JSONValue,
  type Tool,
  type ToolContext
} from '@strands-agents/sdk'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { z } from 'zod'
import { getAgentMemoryPath } from '../helpers/agent-memory-path.js'
import { executeAgentShell, formatAgentShellResult } from '../helpers/agent-shell.js'
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
import type { EffortLevel } from './config.js'

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
const MCP_FILESYSTEM_ROOT = '/'
const MAIL_MCP_URL = 'https://mail.pmh.codes/api/external/v1/mcp'
const MCP_TOOL_NAME_MAX_LENGTH = 64

const MCP_SERVER_CAPABILITIES: Record<string, string> = {
  docker: 'inspect and manage Docker containers, images, volumes, and networks',
  filesystem: 'read, search, create, and modify local files',
  memory: 'store and retrieve persistent knowledge and user-provided facts',
  sequential_thinking: 'work through complex multi-step reasoning',
  fetch: 'retrieve current content from URLs and web APIs',
  time: 'get current times and convert time zones',
  playwright: 'browse and interact with websites in a real browser',
  spotify: 'search Spotify and manage playback and playlists',
  google_calendar: 'read and manage Google Calendar events',
  mail: 'read, search, and manage email'
}

interface AgentMcpConnection {
  client: McpClient
  tools: Tool[]
}

interface AgentMcpCandidate {
  name: string
  client: McpClient
}

const agentMcpConnections = new Map<string, AgentMcpConnection>()
const agentMcpFailures = new Map<string, string>()
let agentMcpBoot: Promise<void> | undefined

function shellTool(signal: AbortSignal): Tool {
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

function waitTool(signal: AbortSignal): Tool {
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

export function createAgentUtilityTools(signal: AbortSignal): Tool[] {
  return [
    shellTool(signal),
    waitTool(signal),
    publishHtmlTool,
    spotifyAuthenticationTool,
    googleCalendarAuthenticationTool
  ]
}

export function describeMcpServers(names: string[]): string {
  return names
    .map((name) => {
      const capability = MCP_SERVER_CAPABILITIES[name]
      return capability ? `${name} (${capability})` : name
    })
    .join('; ')
}

export function replaceDuplicateTools<T extends { name: string }>(tools: T[]): T[] {
  const toolsByNormalizedName = new Map<string, T>()
  for (const candidate of tools) {
    toolsByNormalizedName.set(candidate.name.replaceAll('-', '_'), candidate)
  }
  return [...toolsByNormalizedName.values()]
}

function mcpToolName(serverName: string, toolName: string): string {
  const combined = `${serverName}_${toolName}`
  return combined.length <= MCP_TOOL_NAME_MAX_LENGTH
    ? combined
    : combined.slice(0, MCP_TOOL_NAME_MAX_LENGTH)
}

// The MCP protocol call still uses the original name; only the model-facing name is prefixed.
function prefixMcpTools(serverName: string, tools: Tool[]): Tool[] {
  return tools.map((original) => {
    const name = mcpToolName(serverName, original.name)
    return {
      ...original,
      name,
      toolSpec: { ...original.toolSpec, name },
      stream: (toolContext: ToolContext) => original.stream(toolContext)
    }
  })
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

function builtInMcpCandidates(): AgentMcpCandidate[] {
  return [
    {
      name: 'docker',
      client: new McpClient({
        applicationName: 'solver /a Docker',
        transport: new StdioClientTransport({ command: 'uvx', args: ['mcp-server-docker'] })
      })
    },
    {
      name: 'filesystem',
      client: new McpClient({
        applicationName: 'solver /a Filesystem',
        transport: new StdioClientTransport({
          command: process.execPath,
          args: [FILESYSTEM_MCP_PATH, MCP_FILESYSTEM_ROOT]
        })
      })
    },
    {
      name: 'memory',
      client: new McpClient({
        applicationName: 'solver /a Memory',
        transport: new StdioClientTransport({
          command: process.execPath,
          args: [MEMORY_MCP_PATH],
          env: { MEMORY_FILE_PATH: getAgentMemoryPath() }
        })
      })
    },
    {
      name: 'sequential_thinking',
      client: new McpClient({
        applicationName: 'solver /a Sequential Thinking',
        transport: new StdioClientTransport({
          command: process.execPath,
          args: [SEQUENTIAL_THINKING_MCP_PATH]
        })
      })
    },
    {
      name: 'fetch',
      client: new McpClient({
        applicationName: 'solver /a Fetch',
        transport: new StdioClientTransport({
          command: 'uvx',
          args: ['--with', 'mcp==1.29.0', 'mcp-server-fetch==2026.7.10']
        })
      })
    },
    {
      name: 'time',
      client: new McpClient({
        applicationName: 'solver /a Time',
        transport: new StdioClientTransport({
          command: 'uvx',
          args: ['--with', 'mcp==1.29.0', 'mcp-server-time==2026.7.10']
        })
      })
    },
    {
      name: 'playwright',
      client: new McpClient({
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
    }
  ]
}

function mcpFailureMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

async function bootAgentMcpRuntime(): Promise<void> {
  const candidates = builtInMcpCandidates()
  const [spotifyResult, googleCalendarResult] = await Promise.allSettled([
    loadSpotifyConfiguration(),
    loadGoogleCalendarConfiguration()
  ])
  const spotifyConfiguration = spotifyResult.status === 'fulfilled' ? spotifyResult.value : null
  const googleCalendarConfiguration =
    googleCalendarResult.status === 'fulfilled' ? googleCalendarResult.value : null

  if (spotifyResult.status === 'rejected') {
    agentMcpFailures.set('spotify', mcpFailureMessage(spotifyResult.reason))
  }
  if (googleCalendarResult.status === 'rejected') {
    agentMcpFailures.set('google_calendar', mcpFailureMessage(googleCalendarResult.reason))
  }
  if (spotifyConfiguration) {
    candidates.push({
      name: 'spotify',
      client: new McpClient({
        applicationName: 'solver /a',
        transport: new StdioClientTransport({
          command: process.execPath,
          args: [SPOTIFY_MCP_PATH],
          env: getSpotifyMcpEnvironment(spotifyConfiguration)
        })
      })
    })
  }
  if (googleCalendarConfiguration) {
    candidates.push({
      name: 'google_calendar',
      client: new McpClient({
        applicationName: 'solver /a Google Calendar',
        transport: new StdioClientTransport({
          command: process.execPath,
          args: [GOOGLE_CALENDAR_MCP_PATH],
          env: getGoogleCalendarMcpEnvironment(googleCalendarConfiguration)
        })
      })
    })
  }
  const mailApiKey = process.env.MAIL_API_KEY?.trim()
  if (mailApiKey) {
    candidates.push({
      name: 'mail',
      client: new McpClient({
        applicationName: 'solver /a Mail',
        transport: new StreamableHTTPClientTransport(new URL(MAIL_MCP_URL), {
          requestInit: { headers: { Authorization: `Bearer ${mailApiKey}` } }
        })
      })
    })
  }
  for (const server of loadStoredMcpServers()) {
    candidates.push({ name: server.name, client: storedMcpClient(server) })
  }

  await Promise.all(
    candidates.map(async ({ name, client }) => {
      try {
        const tools = prefixMcpTools(name, await client.listTools())
        agentMcpConnections.set(name, { client, tools })
        agentMcpFailures.delete(name)
      } catch (error) {
        agentMcpFailures.set(name, mcpFailureMessage(error))
        await client.disconnect().catch(() => {})
      }
    })
  )
}

export async function initializeAgentMcpRuntime(): Promise<void> {
  agentMcpBoot ??= bootAgentMcpRuntime()
  await agentMcpBoot
}

export async function callAgentMcpTool(
  serverName: string,
  toolName: string,
  args: JSONValue = {},
  signal?: AbortSignal
): Promise<JSONValue> {
  await initializeAgentMcpRuntime()

  const connection = agentMcpConnections.get(serverName)
  if (!connection) {
    const failure = agentMcpFailures.get(serverName)
    throw new Error(
      failure
        ? `${serverName} MCP is unavailable: ${failure}`
        : `${serverName} MCP is not configured`
    )
  }

  const tools = await connection.client.listTools()
  const selected = tools.find(({ name }) => name === toolName)
  if (!selected) throw new Error(`${serverName} MCP does not provide ${toolName}`)

  return connection.client.callTool(selected, args, signal ? { signal } : undefined)
}

export async function closeAgentMcpRuntime(): Promise<void> {
  await agentMcpBoot?.catch(() => {})
  const clients = [...agentMcpConnections.values()].map(({ client }) => client)
  agentMcpConnections.clear()
  agentMcpFailures.clear()
  agentMcpBoot = undefined
  await Promise.all(clients.map((client) => client.disconnect().catch(() => {})))
}

export function availableMcpServerNames(effort: EffortLevel): string[] {
  return [...agentMcpConnections.keys()].filter(
    (name) => effort !== 'none' || name !== 'sequential_thinking'
  )
}

export function availableMcpTools(effort: EffortLevel): Tool[] {
  return [...agentMcpConnections]
    .filter(([name]) => effort !== 'none' || name !== 'sequential_thinking')
    .flatMap(([, { tools }]) => tools)
}

export function mcpFailureSummary(): string {
  return [...agentMcpFailures].map(([name, message]) => `${name}: ${message}`).join('; ')
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

function mcpServerManagementTool(getAgent: () => Agent): Tool {
  return tool({
    name: 'manage_mcp_servers',
    description:
      'List, attach, replace, remove, or restart MCP servers available to /a. Restart boots the complete configured MCP list again after repairing a startup problem. The persistent server list is stored in the database. A successfully attached or restarted server and its tools are available immediately in this request. Use stdio with an executable command and separate args, or http for a Streamable HTTP MCP endpoint. Stored env and header values are redacted from list output.',
    inputSchema: z.object({
      action: z.enum(['list', 'attach', 'remove', 'restart']),
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
      if (action === 'restart') {
        const previousTools = [...agentMcpConnections.values()].flatMap(({ tools }) => tools)
        await closeAgentMcpRuntime()
        await initializeAgentMcpRuntime()
        const agent = getAgent()
        for (const previousTool of previousTools) {
          if (agent.toolRegistry.get(previousTool.name) === previousTool) {
            agent.toolRegistry.remove(previousTool.name)
          }
        }
        const restartedTools = replaceDuplicateTools(
          [...agentMcpConnections.values()].flatMap(({ tools }) => tools)
        )
        agent.toolRegistry.addOrReplace(restartedTools)
        if (agentMcpFailures.size > 0) {
          const failures = [...agentMcpFailures]
            .map(([serverName, message]) => `${serverName}: ${message}`)
            .join('; ')
          return `Restarted MCP servers with failures: ${failures}. Continue diagnosing and restart again after applying a fix.`
        }
        return `Restarted MCP servers successfully with ${restartedTools.length} tools.`
      }
      if (!name) return 'name is required.'

      if (action === 'remove') {
        const removed = removeStoredMcpServer(name)
        const connection = removed ? agentMcpConnections.get(name) : undefined
        if (removed) agentMcpFailures.delete(name)
        if (connection) {
          const agent = getAgent()
          for (const registeredTool of connection.tools) {
            if (agent.toolRegistry.get(registeredTool.name) === registeredTool) {
              agent.toolRegistry.remove(registeredTool.name)
            }
          }
          agentMcpConnections.delete(name)
          agentMcpFailures.delete(name)
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
        agentMcpConnections.has(server.name) &&
        !storedServers.some(({ name: storedName }) => storedName === server.name)
      ) {
        return `MCP server name ${server.name} is reserved by a built-in integration.`
      }
      if (
        storedServers.length >= MAX_STORED_MCP_SERVERS &&
        !storedServers.some(({ name: storedName }) => storedName === server.name)
      ) {
        return `At most ${MAX_STORED_MCP_SERVERS} MCP servers may be attached.`
      }
      const client = storedMcpClient(server)
      const previous = agentMcpConnections.get(name)
      let serverTools: Tool[]
      try {
        serverTools = replaceDuplicateTools(prefixMcpTools(server.name, await client.listTools()))
      } catch (error) {
        const message = mcpFailureMessage(error)
        if (!previous) agentMcpFailures.set(server.name, message)
        await client.disconnect().catch(() => {})
        return `Could not boot MCP server ${name}: ${message}. Diagnose the configuration or runtime, correct it, and try attaching the server again.`
      }

      const agent = getAgent()
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

      if (previous) await previous.client.disconnect().catch(() => {})
      agentMcpFailures.delete(name)
      agentMcpConnections.set(name, { client, tools: serverTools })
      const toolNames = serverTools.map(({ name: toolName }) => toolName)
      return `Attached MCP server ${name} with ${toolNames.length} tool${toolNames.length === 1 ? '' : 's'}${toolNames.length > 0 ? `: ${toolNames.join(', ')}` : ''}.`
    }
  })
}

function lazyMcpToolLoader(getAgent: () => Agent, effort: EffortLevel): Tool {
  return tool({
    name: 'load_mcp_tools',
    description:
      'Discover and load MCP tools for requests that depend on current or external information, local files or services, private account data, persistent memory, browser interaction, or real-world actions. Available servers and their capabilities are provided in the system prompt. Load the required servers directly when their purpose is clear, or use list first to inspect their tools. Loaded tools become available immediately in the current request.',
    inputSchema: z.object({
      action: z.enum(['list', 'load']),
      servers: z
        .array(mcpServerNameSchema)
        .max(MAX_STORED_MCP_SERVERS)
        .optional()
        .describe('MCP server names returned by list; required for load')
    }),
    callback: async ({ action, servers }) => {
      await initializeAgentMcpRuntime()
      const availableConnections = [...agentMcpConnections].filter(
        ([name]) => effort !== 'none' || name !== 'sequential_thinking'
      )
      if (action === 'list') {
        const catalog = availableConnections.map(([name, { tools }]) => ({
          name,
          tools: tools.map(({ name: toolName, description }) => ({
            name: toolName,
            ...(description ? { description } : {})
          }))
        }))
        return JSON.stringify({
          servers: catalog,
          ...(agentMcpFailures.size > 0 ? { failures: Object.fromEntries(agentMcpFailures) } : {})
        })
      }

      if (!servers?.length) return 'servers is required when loading MCP tools.'
      const requested = new Set(servers)
      const unknown = servers.filter(
        (name) => !availableConnections.some(([availableName]) => availableName === name)
      )
      if (unknown.length > 0) {
        return `Unknown or unavailable MCP server${unknown.length === 1 ? '' : 's'}: ${unknown.join(', ')}. Use list to inspect the available servers.`
      }

      const loadedTools = replaceDuplicateTools(
        availableConnections
          .filter(([name]) => requested.has(name))
          .flatMap(([, { tools }]) => tools)
      )
      getAgent().toolRegistry.addOrReplace(loadedTools)
      return `Loaded ${loadedTools.length} MCP tool${loadedTools.length === 1 ? '' : 's'} from ${servers.join(', ')}${loadedTools.length > 0 ? `: ${loadedTools.map(({ name }) => name).join(', ')}` : ''}.`
    }
  })
}

export function createMcpRuntimeTools(getAgent: () => Agent, effort: EffortLevel): Tool[] {
  return [mcpServerManagementTool(getAgent), lazyMcpToolLoader(getAgent, effort)]
}
