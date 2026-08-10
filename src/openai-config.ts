import { z } from 'zod'
import { deleteStoredValue, getStoredValue, setStoredValue } from './helpers/kv-store.js'
import { decryptWebSecret, encryptWebSecret } from './helpers/web-secret.js'

const OPENAI_ENDPOINT_KEY = 'openai-endpoint'
const OPENAI_TOKEN_KEY = 'openai-token'
export const DEFAULT_OPENAI_ENDPOINT = 'https://api.openai.com/v1'
export const MAX_OPENAI_ENDPOINT_LENGTH = 2048
export const MAX_OPENAI_TOKEN_LENGTH = 4096

const storedOpenAIEndpointSchema = z.object({
  endpoint: z.string().min(1).max(MAX_OPENAI_ENDPOINT_LENGTH),
  isDefault: z.boolean(),
  updatedAt: z.string().datetime(),
  updatedBy: z.string().min(1).max(2048)
})

const storedOpenAITokenSchema = z.object({
  token: z.string().min(1).max(MAX_OPENAI_TOKEN_LENGTH),
  updatedAt: z.string().datetime(),
  updatedBy: z.string().min(1).max(2048)
})

export interface OpenAIEndpointSetting {
  endpoint: string
  isDefault: boolean
  updatedAt: string | null
  updatedBy: string | null
}

export interface OpenAITokenSetting {
  hasOverride: boolean
  hasEnvironmentToken: boolean
  effectiveSource: 'override' | 'environment' | 'missing'
  updatedAt: string | null
  updatedBy: string | null
}

function normalizeOpenAIEndpoint(value: unknown): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error('OpenAI endpoint must not be empty')
  }
  if (value.length > MAX_OPENAI_ENDPOINT_LENGTH) {
    throw new Error(`OpenAI endpoint must not exceed ${MAX_OPENAI_ENDPOINT_LENGTH} characters`)
  }

  let url: URL
  try {
    url = new URL(value.trim())
  } catch {
    throw new Error('OpenAI endpoint must be a valid URL')
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new Error('OpenAI endpoint must use HTTP or HTTPS')
  }
  if (url.username || url.password) throw new Error('OpenAI endpoint must not contain credentials')
  if (url.search || url.hash) {
    throw new Error('OpenAI endpoint must not contain a query string or fragment')
  }
  url.pathname = url.pathname.replace(/\/+$/, '') || '/'
  return url.toString().replace(/\/$/, '')
}

export function loadOpenAIEndpointSetting(): OpenAIEndpointSetting {
  const stored = getStoredValue(OPENAI_ENDPOINT_KEY)
  if (!stored) {
    return {
      endpoint: DEFAULT_OPENAI_ENDPOINT,
      isDefault: true,
      updatedAt: null,
      updatedBy: null
    }
  }
  return storedOpenAIEndpointSchema.parse(JSON.parse(stored))
}

export function loadOpenAIEndpoint(): string {
  return loadOpenAIEndpointSetting().endpoint
}

function persistOpenAIEndpoint(endpoint: string, updatedBy: string): OpenAIEndpointSetting {
  const setting = storedOpenAIEndpointSchema.parse({
    endpoint,
    isDefault: endpoint === DEFAULT_OPENAI_ENDPOINT,
    updatedAt: new Date().toISOString(),
    updatedBy
  })
  setStoredValue(OPENAI_ENDPOINT_KEY, JSON.stringify(setting))
  return setting
}

export function updateOpenAIEndpoint(input: unknown, updatedBy: string): OpenAIEndpointSetting {
  return persistOpenAIEndpoint(
    normalizeOpenAIEndpoint((input as { endpoint?: unknown })?.endpoint),
    updatedBy
  )
}

export function resetOpenAIEndpoint(updatedBy: string): OpenAIEndpointSetting {
  return persistOpenAIEndpoint(DEFAULT_OPENAI_ENDPOINT, updatedBy)
}

export function openAIEndpointUrl(path: string): string {
  return `${loadOpenAIEndpoint()}/${path.replace(/^\/+/, '')}`
}

function loadStoredOpenAIToken(): z.infer<typeof storedOpenAITokenSchema> | null {
  const stored = getStoredValue(OPENAI_TOKEN_KEY)
  if (!stored) return null
  return storedOpenAITokenSchema.parse(
    JSON.parse(decryptWebSecret(stored, 'Invalid encrypted OpenAI token'))
  )
}

export function loadOpenAITokenSetting(): OpenAITokenSetting {
  const override = loadStoredOpenAIToken()
  const hasEnvironmentToken = Boolean(process.env.OPENAI_API_KEY?.trim())
  return {
    hasOverride: Boolean(override),
    hasEnvironmentToken,
    effectiveSource: override ? 'override' : hasEnvironmentToken ? 'environment' : 'missing',
    updatedAt: override?.updatedAt ?? null,
    updatedBy: override?.updatedBy ?? null
  }
}

export function loadOpenAIApiKey(): string | undefined {
  return loadStoredOpenAIToken()?.token ?? (process.env.OPENAI_API_KEY?.trim() || undefined)
}

export function updateOpenAIToken(input: unknown, updatedBy: string): OpenAITokenSetting {
  const value = (input as { token?: unknown })?.token
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error('OpenAI token must not be empty')
  }
  if (value.length > MAX_OPENAI_TOKEN_LENGTH) {
    throw new Error(`OpenAI token must not exceed ${MAX_OPENAI_TOKEN_LENGTH} characters`)
  }
  const stored = storedOpenAITokenSchema.parse({
    token: value.trim(),
    updatedAt: new Date().toISOString(),
    updatedBy
  })
  setStoredValue(OPENAI_TOKEN_KEY, encryptWebSecret(JSON.stringify(stored)))
  return loadOpenAITokenSetting()
}

export function resetOpenAIToken(): OpenAITokenSetting {
  deleteStoredValue(OPENAI_TOKEN_KEY)
  return loadOpenAITokenSetting()
}
