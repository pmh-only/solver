import { z } from 'zod'
import { deleteStoredValue, getStoredValue, setStoredValue } from './helpers/kv-store.js'
import { formatAgentDateTime } from './helpers/timezone.js'

const SYSTEM_PROMPT_KEY = 'global-system-prompt'
const SESSION_SYSTEM_PROMPT_KEY = 'gpt-session-system-prompt'
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

export interface SessionSystemPromptSetting {
  prompt: string
  isSet: boolean
  updatedAt: string | null
  updatedBy: string | null
}

function sessionSystemPromptKey(userId: string, sessionName: string): string {
  void userId
  return `${SESSION_SYSTEM_PROMPT_KEY}:${encodeURIComponent(sessionName)}`
}

function validateSessionName(sessionName: string): string {
  const name = sessionName.trim()
  if (!name) throw new Error('Session name must not be empty')
  if (name.length > 100) throw new Error('Session name must not exceed 100 characters')
  return name
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

export function loadSessionSystemPromptSetting(
  userId: string,
  sessionName: string
): SessionSystemPromptSetting {
  const stored = getStoredValue(sessionSystemPromptKey(userId, validateSessionName(sessionName)))
  if (!stored) return { prompt: '', isSet: false, updatedAt: null, updatedBy: null }
  const setting = storedSystemPromptSchema.parse(JSON.parse(stored))
  return {
    prompt: setting.prompt,
    isSet: true,
    updatedAt: setting.updatedAt,
    updatedBy: setting.updatedBy
  }
}

export function loadEffectiveSystemPrompt(
  userId: string,
  sessionName: string,
  currentDateTime = new Date()
): string {
  const globalPrompt = loadSystemPrompt()
  const sessionPrompt = loadSessionSystemPromptSetting(userId, sessionName)
  const configuredPrompt = sessionPrompt.isSet
    ? `${globalPrompt}\n\nAdditional instructions for the current session:\n${sessionPrompt.prompt}`
    : globalPrompt
  return `${configuredPrompt}\n\nCurrent date and time: ${formatAgentDateTime(currentDateTime)}.`
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

export function updateSessionSystemPrompt(
  userId: string,
  sessionName: string,
  input: unknown,
  updatedBy: string
): SessionSystemPromptSetting {
  const candidate = input as { prompt?: unknown }
  if (typeof candidate?.prompt !== 'string' || !candidate.prompt.trim()) {
    throw new Error('Session system prompt must not be empty')
  }
  if (candidate.prompt.length > MAX_SYSTEM_PROMPT_LENGTH) {
    throw new Error(`Session system prompt must not exceed ${MAX_SYSTEM_PROMPT_LENGTH} characters`)
  }
  const name = validateSessionName(sessionName)
  const setting = storedSystemPromptSchema.parse({
    prompt: candidate.prompt,
    isDefault: false,
    updatedAt: new Date().toISOString(),
    updatedBy
  })
  setStoredValue(sessionSystemPromptKey(userId, name), JSON.stringify(setting))
  return {
    prompt: setting.prompt,
    isSet: true,
    updatedAt: setting.updatedAt,
    updatedBy: setting.updatedBy
  }
}

export function resetSessionSystemPrompt(
  userId: string,
  sessionName: string
): SessionSystemPromptSetting {
  deleteStoredValue(sessionSystemPromptKey(userId, validateSessionName(sessionName)))
  return { prompt: '', isSet: false, updatedAt: null, updatedBy: null }
}
