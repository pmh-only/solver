import { ComponentType, MessageFlags, type InteractionEditReplyOptions } from 'discord.js'
import { randomUUID } from 'node:crypto'
import type { RequestTiming } from '../request-timing.js'
import { AGENT_EFFORT_OPTIONS, type EffortLevel } from './config.js'
import { findComponent, loadGptContext } from './interaction-context.js'
import { activeDiscordRuns, activeWebInteractions, activeWebRuns } from './runtime-state.js'
import {
  DEFAULT_SESSION_NAME,
  GPT_INTERACTION_TTL_MS,
  GPT_MODAL_ID,
  type GptContext,
  type GptManagedComponent,
  type GptSessionSettings,
  type StreamCallbacks
} from './runtime-types.js'
import {
  clearConversation,
  loadAgentSessionNames,
  loadConversation,
  loadSelectedSession,
  loadSessionSettings,
  registerAgentSession,
  resetIdleSession,
  runInSession,
  selectSession,
  sessionKey,
  storeSessionSettings
} from './session-store.js'
import { runActiveAgentContext, runAgentContext } from './run-lifecycle.js'
import { sharedAgentSession } from './session-identity.js'

export interface WebAgentRequest {
  userId: string
  prompt: string
  sessionName?: string
  model?: string
  effort?: string
  maxTokens?: number
  toolsEnabled?: boolean
  runId?: string
  timing?: RequestTiming
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
  selectedSession: string
  settings: GptSessionSettings
}

export interface WebComponentInteractionRequest {
  userId: string
  customId: string
  values?: string[]
}

export function loadWebSessionState(sessionName = loadSelectedSession()): WebSessionState {
  const session = sharedAgentSession(sessionName)
  return {
    sessions: loadAgentSessionNames(),
    selectedSession: loadSelectedSession(),
    settings: loadSessionSettings(session)
  }
}

export function createWebSession(sessionName: string): WebSessionState {
  const session = sharedAgentSession(sessionName)
  loadConversation(session)
  registerAgentSession(session)
  selectSession(session.name)
  return loadWebSessionState(session.name)
}

export function loadWebConversation(sessionName = DEFAULT_SESSION_NAME): WebConversationTurn[] {
  const visible: WebConversationTurn[] = []
  const session = sharedAgentSession(sessionName)
  resetIdleSession(session)
  for (const { role, content, webContent, status } of loadConversation(session).turns) {
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

  const key = sessionKey(session)
  const active = activeWebRuns.get(key)
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
  const discordRun = activeDiscordRuns.get(key)
  if (!active && discordRun && !discordRun.persisted) {
    visible.push(
      { role: 'user', content: discordRun.prompt, status: 'running' },
      {
        role: 'assistant',
        content: JSON.stringify(discordRun.latestPayload),
        status: 'running',
        startedAt: discordRun.startedAt
      }
    )
  }
  return visible
}

export async function cancelWebAgent(
  sessionName = DEFAULT_SESSION_NAME,
  runId?: string
): Promise<boolean> {
  const session = sharedAgentSession(sessionName)
  const active = activeWebRuns.get(sessionKey(session))
  if (!active || (runId && active.id !== runId)) return false
  active.controller.abort()
  await active.done
  return true
}

export async function clearWebConversation(sessionName = DEFAULT_SESSION_NAME): Promise<void> {
  const session = sharedAgentSession(sessionName)
  await cancelWebAgent(session.name)
  await runInSession(session, async () => {
    clearConversation(session)
  })
}

export async function runWebAgent(
  request: WebAgentRequest,
  onUpdate: (payload: InteractionEditReplyOptions) => Promise<void>,
  signal?: AbortSignal
): Promise<void> {
  const timing = request.timing
  timing?.mark('web agent validation started')
  const userId = 'single-user'
  const prompt = request.prompt.trim()
  if (!prompt || prompt.length > 32_000) {
    throw new Error('Prompt must contain 1 to 32,000 characters')
  }
  const session = sharedAgentSession(request.sessionName?.trim() || DEFAULT_SESSION_NAME)
  const sessionName = session.name
  const runId = request.runId ?? randomUUID()
  if (!/^[a-zA-Z0-9-]{1,64}$/.test(runId)) throw new Error('Invalid run identifier')

  const storedSettings = loadSessionSettings(session)
  const effort = request.effort ?? storedSettings.effort
  if (!AGENT_EFFORT_OPTIONS.some(({ id }) => id === effort)) {
    throw new Error('Invalid reasoning effort')
  }
  const maxTokens = request.maxTokens ?? storedSettings.maxTokens
  if (!Number.isInteger(maxTokens) || maxTokens < 256 || maxTokens > 16_384) {
    throw new Error('Token limit must be an integer between 256 and 16384')
  }
  const settings: GptSessionSettings = {
    model: request.model?.trim() || storedSettings.model,
    effort: effort as EffortLevel,
    maxTokens,
    toolsEnabled: request.toolsEnabled ?? storedSettings.toolsEnabled
  }
  if (settings.model.length > 200) throw new Error('Model must not exceed 200 characters')
  storeSessionSettings(session, settings)
  registerAgentSession(session)
  selectSession(sessionName)
  timing?.mark('web agent settings loaded')

  const token = randomUUID().replace(/-/g, '').slice(0, 16)
  const ctx: GptContext = {
    prompt,
    displayPrompt: prompt,
    input: [],
    pub: true,
    model: settings.model,
    effort: settings.effort,
    maxTokens: settings.maxTokens,
    toolsEnabled: settings.toolsEnabled,
    verbosity: 'normal',
    userId,
    sessionName,
    history: [],
    modelHistory: [],
    components: [],
    senderOnlyComponentIds: [],
    modals: {},
    expiresAt: Date.now() + GPT_INTERACTION_TTL_MS
  }
  await runActiveAgentContext('web', ctx, token, webCallbacks(onUpdate), { signal, timing, runId })
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
    if (!values.every((value) => allowed.has(value))) {
      webInteractionError('Invalid interaction values')
    }
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
  const ctx = loadGptContext(parsed.token)
  if (!ctx) webInteractionError('Interaction expired')
  const interactionKey = request.customId
  if (activeWebInteractions.has(interactionKey)) {
    webInteractionError('Interaction already in progress')
  }
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
      await runAgentContext(ctx, parsed.token, webCallbacks(onUpdate), {
        signal,
        prepare: () => {
          const latest = loadGptContext(parsed.token)
          const latestComponent = latest && findComponent(latest.components, request.customId)
          if (!latest || !latestComponent) webInteractionError('Interaction expired')
          validateWebComponentValues(latestComponent, values)
          latest.prompt = JSON.stringify({
            type: 'discord_component',
            custom_id: parsed.stableId,
            values
          })
          delete latest.archiveSearchContext
          return latest
        }
      })
      return { updated: true }
    }

    const modal = ctx.modals[parsed.stableId]
    if (!modal || modal.custom_id !== request.customId) webInteractionError('Interaction expired')
    const fields = normalizeWebModalFields(modal, request.fields)
    await runAgentContext(ctx, parsed.token, webCallbacks(onUpdate), {
      signal,
      prepare: () => {
        const latest = loadGptContext(parsed.token)
        const latestModal = latest?.modals[parsed.stableId]
        if (!latest || !latestModal || latestModal.custom_id !== request.customId)
          webInteractionError('Interaction expired')
        normalizeWebModalFields(latestModal, request.fields)
        latest.prompt = JSON.stringify({
          type: 'discord_modal_submit',
          trigger_id: parsed.stableId,
          fields
        })
        delete latest.archiveSearchContext
        return latest
      }
    })
    return { updated: true }
  } finally {
    activeWebInteractions.delete(interactionKey)
  }
}

export async function runWebComponentInteraction(
  request: WebComponentInteractionRequest,
  onUpdate: (payload: InteractionEditReplyOptions) => Promise<void>,
  signal?: AbortSignal
): Promise<void> {
  const result = await runWebInteraction(request, onUpdate, signal)
  if ('modal' in result) throw new Error('This component requires a Web modal')
}
