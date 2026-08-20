import type { MessageData } from '@strands-agents/sdk'
import { getStoredValue, listStoredKeys, setStoredValue } from '../helpers/kv-store.js'
import { loadOpenAIEndpoint } from '../openai-config.js'
import { AGENT_EFFORT_OPTIONS } from './config.js'
import { activeDiscordRuns, activeWebRuns, sessionQueues } from './runtime-state.js'
import {
  DEFAULT_MAX_TOKENS,
  DEFAULT_MODEL,
  DEFAULT_SESSION_NAME,
  GPT_SESSION_IDLE_TIMEOUT_MS,
  type ConversationTurn,
  type GptContext,
  type GptSessionSettings,
  type ResponseState,
  type StoredConversation
} from './runtime-types.js'

const GPT_SESSION_KEY = 'gpt-session'
const GPT_SESSION_ACTIVITY_KEY = 'gpt-session-activity'
const GPT_SELECTED_SESSION_KEY = 'gpt-session-selected'
const GPT_SETTINGS_KEY = 'gpt-settings'
const GPT_SESSIONS_KEY = 'gpt-sessions'
const GPT_WEB_SESSIONS_KEY = 'gpt-web-sessions'

export function loadSelectedSession(): string {
  const selected = getStoredValue(GPT_SELECTED_SESSION_KEY)?.trim()
  return selected && selected.length <= 100 ? selected : DEFAULT_SESSION_NAME
}

export function selectSession(sessionName: string): void {
  setStoredValue(GPT_SELECTED_SESSION_KEY, sessionName)
}

export function sessionKey(sessionName: string): string {
  return `${GPT_SESSION_KEY}:${encodeURIComponent(sessionName)}`
}

function sessionActivityKey(sessionName: string): string {
  return `${GPT_SESSION_ACTIVITY_KEY}:${encodeURIComponent(sessionName)}`
}

function sessionIsIdle(sessionName: string, now: number): boolean {
  const lastActivity = Number(getStoredValue(sessionActivityKey(sessionName)))
  return Number.isFinite(lastActivity) && now - lastActivity >= GPT_SESSION_IDLE_TIMEOUT_MS
}

export function beginSessionCommand(userId: string, sessionName: string): void {
  void userId
  const now = Date.now()
  if (sessionIsIdle(sessionName, now)) clearConversation(sessionName)
  setStoredValue(sessionActivityKey(sessionName), String(now))
}

export function finishSessionCommand(userId: string, sessionName: string): void {
  void userId
  setStoredValue(sessionActivityKey(sessionName), String(Date.now()))
}

export function resetIdleSession(userId: string, sessionName: string): void {
  void userId
  const key = sessionKey(sessionName)
  if (
    sessionQueues.has(key) ||
    activeWebRuns.has(key) ||
    activeDiscordRuns.has(key) ||
    !sessionIsIdle(sessionName, Date.now())
  ) {
    return
  }
  clearConversation(sessionName)
}

export function clearConversation(sessionName: string): void {
  setStoredValue(sessionKey(sessionName), '[]')
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
  void userId
  const sessions = new Set([DEFAULT_SESSION_NAME])
  addStoredSessionNames(sessions, getStoredValue(GPT_SESSIONS_KEY))
  addStoredSessionNames(sessions, getStoredValue(GPT_WEB_SESSIONS_KEY))

  const prefix = `${GPT_SESSION_KEY}:`
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

export function registerAgentSession(userId: string, sessionName: string): void {
  const sessions = new Set(loadAgentSessionNames(userId))
  sessions.add(sessionName)
  setStoredValue(GPT_SESSIONS_KEY, JSON.stringify([...sessions]))
}

function settingsKey(sessionName: string): string {
  return `${GPT_SETTINGS_KEY}:${encodeURIComponent(sessionName)}`
}

export function loadSessionSettings(userId: string, sessionName: string): GptSessionSettings {
  void userId
  const defaults: GptSessionSettings = {
    model: DEFAULT_MODEL,
    effort: 'medium',
    maxTokens: DEFAULT_MAX_TOKENS,
    toolsEnabled: false
  }
  const stored = getStoredValue(settingsKey(sessionName))
  if (!stored) return defaults

  try {
    const settings = JSON.parse(stored) as Partial<GptSessionSettings>
    const model = settings.model
    const effort = settings.effort
    return {
      model: typeof model === 'string' && model.trim() ? model : defaults.model,
      effort:
        effort && AGENT_EFFORT_OPTIONS.some(({ id }) => id === effort) ? effort : defaults.effort,
      maxTokens:
        Number.isInteger(settings.maxTokens) &&
        settings.maxTokens !== undefined &&
        settings.maxTokens >= 256 &&
        settings.maxTokens <= 16384
          ? settings.maxTokens
          : defaults.maxTokens,
      toolsEnabled:
        typeof settings.toolsEnabled === 'boolean' ? settings.toolsEnabled : defaults.toolsEnabled
    }
  } catch {
    return defaults
  }
}

export function storeSessionSettings(
  userId: string,
  sessionName: string,
  settings: GptSessionSettings
): void {
  void userId
  setStoredValue(settingsKey(sessionName), JSON.stringify(settings))
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

function validResponseState(value: unknown): value is ResponseState {
  return (
    Boolean(value) &&
    typeof value === 'object' &&
    typeof (value as ResponseState).id === 'string' &&
    typeof (value as ResponseState).model === 'string' &&
    typeof (value as ResponseState).endpoint === 'string'
  )
}

function legacyAgentMessages(history: ConversationTurn[]): MessageData[] {
  return history.map((turn) => ({
    role: turn.role,
    content: [{ text: turn.content }]
  }))
}

export function loadConversation(userId: string, sessionName: string): StoredConversation {
  void userId
  const key = sessionKey(sessionName)
  const stored = getStoredValue(key)
  if (stored === undefined) {
    clearConversation(sessionName)
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
      const conversation = parsed as StoredConversation
      return {
        version: 2,
        turns: conversation.turns,
        messages: conversation.messages,
        ...(validResponseState(conversation.responseState)
          ? { responseState: conversation.responseState }
          : {})
      }
    }
    return { version: 2, turns: [], messages: [] }
  } catch {
    return { version: 2, turns: [], messages: [] }
  }
}

export function storeConversation(
  ctx: GptContext,
  response: string,
  messages: MessageData[],
  webContent?: string,
  status: ConversationTurn['status'] = 'complete'
): void {
  setStoredValue(
    sessionKey(ctx.sessionName),
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
      messages,
      ...(ctx.responseState ? { responseState: ctx.responseState } : {})
    } satisfies StoredConversation)
  )
}

export function loadContextConversation(ctx: GptContext): void {
  const conversation = loadConversation(ctx.userId, ctx.sessionName)
  const responseState = conversation.responseState
  const canContinueResponse =
    responseState?.model === ctx.model && responseState.endpoint === loadOpenAIEndpoint()
  ctx.history = conversation.turns
  ctx.modelHistory =
    conversation.messages.length > 0 || canContinueResponse
      ? conversation.messages
      : legacyAgentMessages(conversation.turns)
  ctx.responseState = canContinueResponse ? responseState : undefined
}

export function fallbackHistoryMessages(ctx: GptContext): MessageData[] {
  return legacyAgentMessages(ctx.history)
}

export function fallbackTurnMessages(ctx: GptContext, assistantText: string): MessageData[] {
  return [
    ...fallbackHistoryMessages(ctx),
    { role: 'user', content: [{ text: ctx.prompt }] },
    { role: 'assistant', content: [{ text: assistantText }] }
  ]
}

export async function runInSession(
  userId: string,
  sessionName: string,
  operation: () => Promise<void>
): Promise<void> {
  void userId
  const key = sessionKey(sessionName)
  const previous = sessionQueues.get(key) ?? Promise.resolve()
  const current = previous.catch(() => {}).then(operation)
  sessionQueues.set(key, current)

  try {
    await current
  } finally {
    if (sessionQueues.get(key) === current) sessionQueues.delete(key)
  }
}
