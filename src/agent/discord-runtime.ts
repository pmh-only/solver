import {
  ComponentType,
  escapeMarkdown,
  MessageFlags,
  ModalBuilder,
  SeparatorSpacingSize,
  type ChatInputCommandInteraction,
  type MessageComponentInteraction,
  type ModalSubmitInteraction,
  type StringSelectMenuInteraction
} from 'discord.js'
import { randomUUID } from 'node:crypto'
import { performance } from 'node:perf_hooks'
import { isAdminUser } from '../authorization.js'
import { errorContainer, matchesInteractiveId } from '../components.js'
import { resetOpenAIEndpoint, updateOpenAIEndpoint } from '../openai-config.js'
import { formatTimingReport, RequestTiming } from '../request-timing.js'
import { resetSessionSystemPrompt, updateSessionSystemPrompt } from '../system-prompt.js'
import { receiveAgentAttachment } from './attachment.js'
import type { EffortLevel } from './config.js'
import {
  deleteGptContext,
  hasComponentId,
  loadGptContext,
  storeGptContext
} from './interaction-context.js'
import {
  buildAgentCancelledPayload,
  buildAgentProgressPayload,
  buildGptComponents,
  footerSessionName,
  makeCallbacks,
  tokenFromId
} from './response-renderer.js'
import { activeDiscordRuns, cancelActiveSession, type ActiveDiscordRun } from './runtime-state.js'
import {
  DEFAULT_SESSION_NAME,
  GPT_ACTION_COMPONENT_ID,
  GPT_EFFORT_SELECT_ID,
  GPT_INTERACTION_TTL_MS,
  GPT_MODAL_ID,
  GPT_MODEL_SELECT_ID,
  GPT_VERBOSITY_SELECT_ID,
  SLOW_RESPONSE_MS,
  type GptContext,
  type GptSessionSettings,
  type StreamCallbacks
} from './runtime-types.js'
import {
  beginSessionCommand,
  clearConversation,
  finishSessionCommand,
  loadContextConversation,
  loadConversation,
  loadSelectedSession,
  loadSessionSettings,
  registerAgentSession,
  runInSession,
  selectSession,
  sessionKey,
  storeSessionSettings
} from './session-store.js'
import { runGptStream } from './stream-runner.js'

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
    if (updatedCtx.components.length === 0 && Object.keys(updatedCtx.modals).length === 0) {
      deleteGptContext(token)
    } else {
      storeGptContext(token, updatedCtx)
    }
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
      if (ctx.components.length === 0 && Object.keys(ctx.modals).length === 0) {
        deleteGptContext(token)
      } else {
        storeGptContext(token, ctx)
      }
    }
  })
}

async function rejectUnauthorizedGptInteraction(
  interaction: MessageComponentInteraction | ModalSubmitInteraction,
  ctx: GptContext,
  componentId: string
): Promise<boolean> {
  if (
    !ctx.senderOnlyComponentIds.includes(componentId) ||
    interaction.user.id === ctx.userId ||
    isAdminUser(interaction.user.id)
  ) {
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
    if (ctx.components.length === 0 && Object.keys(ctx.modals).length === 0) {
      deleteGptContext(token)
    } else {
      storeGptContext(token, ctx)
    }
  })
}

export async function handleAgentCommand(interaction: ChatInputCommandInteraction): Promise<void> {
  const startedAt = Date.now()
  const debug = interaction.options.getBoolean('debug') ?? false
  const timing = debug ? new RequestTiming() : undefined
  timing?.mark('Discord interaction received')
  const prompt = interaction.options.getString('prompt', true).trim()
  const attachment = interaction.options.getAttachment('attachment')
  if (prompt === '/clear' && attachment) throw new Error('attachments cannot be used with /clear')
  const attachmentInput = attachment ? await receiveAgentAttachment(attachment) : undefined
  const requestedSession = interaction.options.getString('session')?.trim()
  const sessionName = requestedSession || loadSelectedSession() || DEFAULT_SESSION_NAME
  selectSession(sessionName)
  registerAgentSession(interaction.user.id, sessionName)

  const requestedSystemPrompt = interaction.options.getString('system_prompt')
  const resetSystemPrompt = interaction.options.getBoolean('reset_system_prompt') ?? false
  const requestedOpenAIEndpoint = interaction.options.getString('openai_endpoint')
  const resetEndpoint = interaction.options.getBoolean('reset_openai_endpoint') ?? false
  if (requestedSystemPrompt && resetSystemPrompt) {
    throw new Error('Choose either system_prompt or reset_system_prompt, not both')
  }
  if (requestedSystemPrompt) {
    updateSessionSystemPrompt(
      interaction.user.id,
      sessionName,
      { prompt: requestedSystemPrompt },
      interaction.user.id
    )
  } else if (resetSystemPrompt) {
    resetSessionSystemPrompt(interaction.user.id, sessionName)
  }
  if (requestedOpenAIEndpoint && resetEndpoint) {
    throw new Error('Choose either openai_endpoint or reset_openai_endpoint, not both')
  }
  if (requestedOpenAIEndpoint) {
    updateOpenAIEndpoint({ endpoint: requestedOpenAIEndpoint }, interaction.user.id)
  } else if (resetEndpoint) {
    resetOpenAIEndpoint(interaction.user.id)
  }

  if (prompt === '/clear') {
    const clearStarted = performance.now()
    await interaction.deferReply()
    cancelActiveSession(sessionKey(sessionName))
    await runInSession(interaction.user.id, sessionName, async () => {
      beginSessionCommand(interaction.user.id, sessionName)
      try {
        clearConversation(sessionName)
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
      } finally {
        finishSessionCommand(interaction.user.id, sessionName)
      }
    })
    timing?.span('clear session and deliver response', clearStarted)
    if (timing) {
      timing.mark('agent request complete')
      await sendDiscordTiming(interaction, timing)
    }
    return
  }

  loadConversation(interaction.user.id, sessionName)
  const storedSettings = loadSessionSettings(interaction.user.id, sessionName)
  const requestedModel = interaction.options.getString('model')
  const requestedEffort = interaction.options.getString('effort') as EffortLevel | null
  const requestedMaxTokens = interaction.options.getInteger('tokens')
  const requestedToolsEnabled = interaction.options.getBoolean('tools')
  const settings: GptSessionSettings = {
    model: requestedModel ?? storedSettings.model,
    effort: requestedEffort ?? storedSettings.effort,
    maxTokens: requestedMaxTokens ?? storedSettings.maxTokens,
    toolsEnabled: requestedToolsEnabled ?? storedSettings.toolsEnabled
  }
  storeSessionSettings(interaction.user.id, sessionName, settings)
  const pub = true
  const token = randomUUID().replace(/-/g, '').slice(0, 16)
  const ctx: GptContext = {
    prompt,
    displayPrompt: attachmentInput
      ? `${prompt}\n-# Attachment: ${escapeMarkdown(attachmentInput.displayName)}`
      : prompt,
    input: attachmentInput
      ? [
          { text: `${prompt}\n\nAttached file: ${attachmentInput.displayName}` },
          attachmentInput.content
        ]
      : [],
    pub,
    model: settings.model,
    effort: settings.effort,
    maxTokens: settings.maxTokens,
    toolsEnabled: settings.toolsEnabled,
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

  let phaseStarted = performance.now()
  await interaction.deferReply()
  timing?.span('Discord acknowledgement', phaseStarted)
  phaseStarted = performance.now()
  await interaction.editReply(buildAgentProgressPayload(ctx))
  timing?.span('initial Discord response', phaseStarted)

  const callbacks = makeCallbacks(interaction, pub)
  const key = sessionKey(sessionName)
  cancelActiveSession(key)
  const active: ActiveDiscordRun = {
    prompt,
    startedAt: new Date().toISOString(),
    controller: new AbortController(),
    latestPayload: buildAgentProgressPayload(ctx),
    persisted: false
  }
  activeDiscordRuns.set(key, active)
  try {
    const queueStarted = performance.now()
    await runInSession(interaction.user.id, sessionName, async () => {
      timing?.span('session queue wait', queueStarted)
      const sharedCallbacks: StreamCallbacks = {
        editMain: callbacks.editMain,
        editPayload: async (payload) => {
          active.latestPayload = payload
          await callbacks.editPayload(payload)
        },
        stored: () => {
          active.persisted = true
        }
      }
      beginSessionCommand(interaction.user.id, sessionName)
      try {
        if (active.controller.signal.aborted) {
          await callbacks.editPayload(
            buildAgentCancelledPayload(ctx, { reasoning: '', tools: [], responseStarted: false })
          )
          return
        }
        const loadStarted = performance.now()
        loadContextConversation(ctx)
        timing?.span('conversation load', loadStarted)
        storeGptContext(token, ctx)
        await runGptStream(sharedCallbacks, ctx, token, active.controller.signal, timing)
      } finally {
        if (ctx.components.length === 0 && Object.keys(ctx.modals).length === 0) {
          deleteGptContext(token)
        } else {
          storeGptContext(token, ctx)
        }
        finishSessionCommand(interaction.user.id, sessionName)
      }
    })
  } finally {
    if (activeDiscordRuns.get(key) === active) activeDiscordRuns.delete(key)
  }
  if (timing && !active.controller.signal.aborted) {
    timing.mark('agent request complete')
    await sendDiscordTiming(interaction, timing)
  }
  if (!active.controller.signal.aborted && Date.now() - startedAt >= SLOW_RESPONSE_MS) {
    await interaction.followUp({
      content: '완료되었습니다.',
      allowedMentions: { parse: [] }
    })
  }
}

async function sendDiscordTiming(
  interaction: ChatInputCommandInteraction,
  timing: RequestTiming
): Promise<void> {
  const lines = formatTimingReport(timing.snapshot()).split('\n')
  let chunk = ''
  for (const line of lines) {
    if (chunk && chunk.length + line.length + 1 > 1900) {
      await interaction.followUp({ content: chunk, allowedMentions: { parse: [] } })
      chunk = '**Debug timing (continued)**'
    }
    chunk += `${chunk ? '\n' : ''}${line}`
  }
  if (chunk) await interaction.followUp({ content: chunk, allowedMentions: { parse: [] } })
}
