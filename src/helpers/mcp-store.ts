import { z } from 'zod'
import { getStoredValue, setStoredValue } from './kv-store.js'

export const MCP_SERVERS_KEY = 'gpt-mcp-servers'
export const MAX_STORED_MCP_SERVERS = 32

export const mcpServerNameSchema = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .regex(/^[a-z0-9][a-z0-9_-]*$/)

const stringMapSchema = z
  .record(z.string().min(1).max(256), z.string().max(16_384))
  .refine((value) => Object.keys(value).length <= 64, 'At most 64 entries are allowed')

const stdioMcpServerSchema = z.object({
  name: mcpServerNameSchema,
  transport: z.literal('stdio'),
  command: z.string().trim().min(1).max(4096),
  args: z.array(z.string().max(4096)).max(100).optional(),
  env: stringMapSchema.optional(),
  cwd: z.string().trim().min(1).max(4096).optional()
})

const httpUrlSchema = z
  .string()
  .trim()
  .max(2048)
  .refine((value) => {
    try {
      return ['http:', 'https:'].includes(new URL(value).protocol)
    } catch {
      return false
    }
  }, 'MCP URL must be a valid HTTP or HTTPS URL')

const httpMcpServerSchema = z.object({
  name: mcpServerNameSchema,
  transport: z.literal('http'),
  url: httpUrlSchema,
  headers: stringMapSchema.optional()
})

export const storedMcpServerSchema = z.discriminatedUnion('transport', [
  stdioMcpServerSchema,
  httpMcpServerSchema
])

const storedMcpServersSchema = z
  .array(storedMcpServerSchema)
  .max(MAX_STORED_MCP_SERVERS)
  .refine(
    (servers) => new Set(servers.map(({ name }) => name)).size === servers.length,
    'MCP server names must be unique'
  )

export type StoredMcpServer = z.infer<typeof storedMcpServerSchema>

export function loadStoredMcpServers(): StoredMcpServer[] {
  const stored = getStoredValue(MCP_SERVERS_KEY)
  if (!stored) return []

  try {
    const parsed = storedMcpServersSchema.safeParse(JSON.parse(stored))
    return parsed.success ? parsed.data : []
  } catch {
    return []
  }
}

export function upsertStoredMcpServer(server: StoredMcpServer): void {
  const validated = storedMcpServerSchema.parse(server)
  const servers = loadStoredMcpServers()
  const index = servers.findIndex(({ name }) => name === validated.name)
  if (index === -1) servers.push(validated)
  else servers[index] = validated
  setStoredValue(MCP_SERVERS_KEY, JSON.stringify(storedMcpServersSchema.parse(servers)))
}

export function removeStoredMcpServer(name: string): boolean {
  const validatedName = mcpServerNameSchema.parse(name)
  const servers = loadStoredMcpServers()
  const remaining = servers.filter((server) => server.name !== validatedName)
  if (remaining.length === servers.length) return false
  setStoredValue(MCP_SERVERS_KEY, JSON.stringify(remaining))
  return true
}
