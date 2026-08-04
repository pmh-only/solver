import { z } from 'zod'
import { getStoredValue, setStoredValue } from './helpers/kv-store.js'

const SYSTEM_PROMPT_KEY = 'global-system-prompt'
export const MAX_SYSTEM_PROMPT_LENGTH = 32_000

export const DEFAULT_SYSTEM_PROMPT =
  "You are Solver, a capable assistant. Follow the user's instructions carefully and use the available tools when they help."

const storedSystemPromptSchema = z.object({
  prompt: z.string().min(1).max(MAX_SYSTEM_PROMPT_LENGTH),
  isDefault: z.boolean(),
  updatedAt: z.string().datetime(),
  updatedBy: z.string().min(1).max(2048)
})

export interface SystemPromptSetting {
  prompt: string
  isDefault: boolean
  updatedAt: string | null
  updatedBy: string | null
}

export function loadSystemPromptSetting(): SystemPromptSetting {
  const stored = getStoredValue(SYSTEM_PROMPT_KEY)
  if (!stored) {
    return { prompt: DEFAULT_SYSTEM_PROMPT, isDefault: true, updatedAt: null, updatedBy: null }
  }
  return storedSystemPromptSchema.parse(JSON.parse(stored))
}

export function loadSystemPrompt(): string {
  return loadSystemPromptSetting().prompt
}

function persistSystemPrompt(
  prompt: string,
  isDefault: boolean,
  updatedBy: string
): SystemPromptSetting {
  const setting = storedSystemPromptSchema.parse({
    prompt,
    isDefault,
    updatedAt: new Date().toISOString(),
    updatedBy
  })
  setStoredValue(SYSTEM_PROMPT_KEY, JSON.stringify(setting))
  return setting
}

export function updateSystemPrompt(input: unknown, updatedBy: string): SystemPromptSetting {
  const candidate = input as { prompt?: unknown }
  if (typeof candidate?.prompt !== 'string' || !candidate.prompt.trim()) {
    throw new Error('System prompt must not be empty')
  }
  if (candidate.prompt.length > MAX_SYSTEM_PROMPT_LENGTH) {
    throw new Error(`System prompt must not exceed ${MAX_SYSTEM_PROMPT_LENGTH} characters`)
  }
  const prompt = candidate.prompt
  return persistSystemPrompt(prompt, prompt === DEFAULT_SYSTEM_PROMPT, updatedBy)
}

export function resetSystemPrompt(updatedBy: string): SystemPromptSetting {
  return persistSystemPrompt(DEFAULT_SYSTEM_PROMPT, true, updatedBy)
}
