import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ComponentType,
  ContainerBuilder,
  escapeMarkdown,
  MessageFlags,
  SeparatorBuilder,
  SeparatorSpacingSize,
  StringSelectMenuBuilder,
  StringSelectMenuOptionBuilder,
  TextDisplayBuilder,
  type InteractionEditReplyOptions
} from 'discord.js'
import type { Usage } from '@strands-agents/sdk'
import { PIN_BUTTON_ID } from '../components.js'
import { AGENT_EFFORT_OPTIONS, type EffortLevel } from './config.js'
import { hasComponentId, validateComponents } from './interaction-context.js'
import {
  GPT_ACTION_COMPONENT_ID,
  GPT_EFFORT_SELECT_ID,
  GPT_VERBOSITY_SELECT_ID,
  MAX_TEXT_DISPLAY_LENGTH,
  VERBOSITY_OPTIONS,
  type AgentActivity,
  type GptComponent,
  type GptContext,
  type GptManagedComponent,
  type StreamCallbacks,
  type VerbosityLevel
} from './runtime-types.js'

export function footerSessionName(sessionName: string): string {
  return escapeMarkdown(sessionName.replace(/\s+/g, ' '))
}

function keepEnd(value: string, maxLength: number): string {
  return maxLength > 0 ? value.slice(-maxLength) : ''
}

function usageFooter(model: string, effort: EffortLevel, maxTokens: number, usage?: Usage): string {
  const tokens = usage
    ? `${usage.inputTokens.toLocaleString('en-US')} in / ${usage.outputTokens.toLocaleString('en-US')} out / ${usage.totalTokens.toLocaleString('en-US')} total`
    : 'unavailable'
  return `-# Tokens used: ${tokens} | Model: ${model} | Reasoning effort: ${effort} | Token limit: ${maxTokens.toLocaleString('en-US')}`
}

function formatAgentActivity(activity: AgentActivity): string {
  const counts = new Map<string, number>()
  for (const { name } of activity.tools) counts.set(name, (counts.get(name) ?? 0) + 1)
  if (counts.size === 0) return ''
  const summary = [...counts]
    .map(([name, count]) => `${name.replaceAll('`', '')}x${count}`)
    .join(', ')
  return `-# (${keepEnd(summary, MAX_TEXT_DISPLAY_LENGTH - 5)})`
}

function agentPromptHeaderComponents(ctx: GptContext): GptManagedComponent[] {
  return [
    { type: ComponentType.TextDisplay, content: `**${ctx.displayPrompt}**` },
    { type: ComponentType.Separator, divider: true, spacing: SeparatorSpacingSize.Small }
  ]
}

export function buildAgentProgressPayload(
  ctx: GptContext,
  activity: AgentActivity = { reasoning: '', tools: [], responseStarted: false },
  responsePreview = ''
): InteractionEditReplyOptions {
  const activityText = formatAgentActivity(activity)
  return {
    content: null,
    embeds: [],
    components: [
      ...agentPromptHeaderComponents(ctx),
      ...(responsePreview
        ? [
            {
              type: ComponentType.TextDisplay,
              content: keepEnd(responsePreview, MAX_TEXT_DISPLAY_LENGTH)
            } as GptManagedComponent
          ]
        : []),
      ...(activityText
        ? [{ type: ComponentType.TextDisplay, content: activityText } as GptManagedComponent]
        : []),
      { type: ComponentType.TextDisplay, content: '-# generating...' }
    ] as never,
    flags: MessageFlags.IsComponentsV2,
    allowedMentions: { parse: [] }
  }
}

export function buildAgentCancelledPayload(
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
  const parsed: unknown = JSON.parse(input.trim())
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('The response must be a JSON object.')
  }
  return parsed as Record<string, unknown>
}

export function buildAgentPayload(
  response: string,
  token: string,
  ctx: GptContext,
  usage?: Usage,
  activity: AgentActivity = { reasoning: '', tools: [], responseStarted: false }
): InteractionEditReplyOptions {
  const raw = parseJsonObject(response)
  const allowed = new Set([
    'content',
    'components',
    'allowed_mentions',
    'allowedMentions',
    'attachments',
    'flags'
  ])
  for (const key of Object.keys(raw)) {
    if (!allowed.has(key)) throw new Error(`Unsupported Discord response field: ${key}`)
  }

  const payload = { ...raw } as Record<string, unknown>
  if (payload.content !== undefined && payload.content !== null) {
    throw new Error('The content field must be omitted or null for Components V2 responses.')
  }
  if (!Array.isArray(payload.components) || payload.components.length === 0) {
    throw new Error('Components V2 responses must contain a non-empty components array.')
  }
  if (!Number.isInteger(payload.flags) || ((payload.flags as number) & 32768) === 0) {
    throw new Error('Components V2 responses must set the flags field to include 32768.')
  }
  if ('allowed_mentions' in payload) {
    payload.allowedMentions = payload.allowed_mentions
    delete payload.allowed_mentions
  }

  const { components, senderOnlyIds } = validateComponents(
    JSON.stringify(payload.components),
    token
  )
  ctx.components = components
  ctx.senderOnlyComponentIds = senderOnlyIds
  for (const triggerId of Object.keys(ctx.modals)) {
    if (!hasComponentId(components, `${GPT_ACTION_COMPONENT_ID}:${token}:${triggerId}`)) {
      delete ctx.modals[triggerId]
    }
  }
  const flags = payload.flags as number
  const footer = usageFooter(ctx.model, ctx.effort, ctx.maxTokens, usage)
  const activityText = formatAgentActivity(activity)

  const header = agentPromptHeaderComponents(ctx)
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
  payload.components = components
  payload.flags = flags

  return payload as InteractionEditReplyOptions
}

export function responseFailureDetail(error: unknown): string {
  if (!error || typeof error !== 'object') return String(error)
  const value = error as Record<string, unknown>
  const details: string[] = [error instanceof Error ? error.message : String(error)]
  if (typeof value.code === 'number' || typeof value.code === 'string') {
    details.push(`code=${String(value.code)}`)
  }
  if (typeof value.status === 'number') details.push(`status=${value.status}`)
  const rawError = value.rawError
  if (rawError && typeof rawError === 'object') {
    const raw = rawError as Record<string, unknown>
    const safeRaw = {
      ...(raw.code !== undefined ? { code: raw.code } : {}),
      ...(raw.message !== undefined ? { message: raw.message } : {}),
      ...(raw.errors !== undefined ? { errors: raw.errors } : {})
    }
    if (Object.keys(safeRaw).length > 0) details.push(`discord=${JSON.stringify(safeRaw)}`)
  }
  return details.join('; ').slice(0, 8_000)
}

export function correctionPrompt(
  originalRequest: string,
  previousOutput: string,
  failureType: 'validation' | 'Discord API',
  detail: string
): string {
  return [
    'Your previous Discord response was rejected. Return a corrected replacement as exactly one complete JSON object with no prose or Markdown fence.',
    'The replacement must use raw Discord API component objects, include a non-empty components array, set flags to include 32768, and omit content or set it to null. Do not use embeds or polls.',
    `Original request: ${JSON.stringify(originalRequest)}`,
    `Previous output: ${JSON.stringify(previousOutput)}`,
    `${failureType} error: ${detail}`
  ].join('\n')
}

export function tokenFromId(customId: string, baseId: string): string | null {
  const prefix = `${baseId}:`
  if (!customId.startsWith(prefix)) return null
  return customId.slice(prefix.length)
}

export function buildGptComponents(
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

  const container = new ContainerBuilder()
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
    container.addTextDisplayComponents(
      new TextDisplayBuilder().setContent(usageFooter(model, effort, maxTokens, usage))
    )
  }

  const components: GptComponent[] = [container, ...managedComponents]
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
            AGENT_EFFORT_OPTIONS.map((option) =>
              new StringSelectMenuOptionBuilder().setLabel(option.label).setValue(option.id)
            )
          )
      ),
      new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
        new StringSelectMenuBuilder()
          .setCustomId(`${GPT_VERBOSITY_SELECT_ID}:${token}`)
          .setPlaceholder(`Verbosity: ${verbosity}`)
          .addOptions(
            VERBOSITY_OPTIONS.map((option) =>
              new StringSelectMenuOptionBuilder().setLabel(option.label).setValue(option.id)
            )
          )
      )
    )
  }

  return components
}

export function makeCallbacks(
  interaction: {
    editReply: (options: { components: never; flags: number }) => Promise<unknown>
  },
  pub: boolean
): StreamCallbacks {
  void pub
  return {
    editMain: (components) =>
      interaction.editReply({
        components: components as never,
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
