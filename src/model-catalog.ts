import { loadOpenAIEndpoint, openAIEndpointUrl } from './openai-config.js'

const MODEL_CACHE_TTL_MS = 5 * 60 * 1000

let cache:
  | {
      apiKey: string
      endpoint: string
      expiresAt: number
      models: string[]
    }
  | undefined

export interface ModelsResponse {
  models: string[]
}

export function clearModelCache(): void {
  cache = undefined
}

export async function loadAvailableModels(): Promise<string[]> {
  const apiKey = process.env.OPENAI_API_KEY?.trim()
  if (!apiKey) return []
  const endpoint = loadOpenAIEndpoint()

  if (
    cache &&
    cache.apiKey === apiKey &&
    cache.endpoint === endpoint &&
    cache.expiresAt > Date.now()
  ) {
    return [...cache.models]
  }

  const response = await fetch(openAIEndpointUrl('models'), {
    headers: { Authorization: `Bearer ${apiKey}` }
  })
  if (!response.ok) throw new Error(`OpenAI models request failed with status ${response.status}`)

  const payload: unknown = await response.json()
  if (
    !payload ||
    typeof payload !== 'object' ||
    !Array.isArray((payload as { data?: unknown }).data)
  ) {
    throw new Error('OpenAI models response is invalid')
  }

  const models = [
    ...new Set(
      (payload as { data: unknown[] }).data.flatMap((entry) => {
        if (!entry || typeof entry !== 'object') return []
        const id = (entry as { id?: unknown }).id
        return typeof id === 'string' && id.trim() ? [id] : []
      })
    )
  ].sort((a, b) => a.localeCompare(b))

  cache = { apiKey, endpoint, expiresAt: Date.now() + MODEL_CACHE_TTL_MS, models }
  return [...models]
}

export async function loadModelsResponse(): Promise<ModelsResponse> {
  return { models: await loadAvailableModels() }
}
