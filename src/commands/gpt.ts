import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ContainerBuilder,
  MessageFlags,
  SeparatorBuilder,
  SeparatorSpacingSize,
  StringSelectMenuBuilder,
  StringSelectMenuOptionBuilder,
  TextDisplayBuilder
} from 'discord.js'
import type { ChatInputCommandInteraction, StringSelectMenuInteraction } from 'discord.js'
import { Agent } from '@strands-agents/sdk'
import { OpenAIModel } from '@strands-agents/sdk/models/openai'
import { randomUUID } from 'node:crypto'
import { container, matchesInteractiveId, PIN_BUTTON_ID, PUB_BUTTON_ID } from '../components.js'
import { getStoredValue, setStoredValue } from '../helpers/kv-store.js'

export const GPT_MODEL_SELECT_ID = 'gpt-model'
export const GPT_EFFORT_SELECT_ID = 'gpt-effort'
export const GPT_VERBOSITY_SELECT_ID = 'gpt-verbosity'
export const AGENT_COMMAND_NAME = 'a'

const GPT_COLOR = 0x10a37f
const PAGE_LIMIT = 3600
const EDIT_INTERVAL_MS = 750

export const GPT_MODELS = [
  { id: 'gpt-5.4', label: 'GPT-5.4' },
  { id: 'gpt-5.4-pro', label: 'GPT-5.4 pro' },
  { id: 'gpt-5.4-mini', label: 'GPT-5.4 mini' },
  { id: 'gpt-5.4-nano', label: 'GPT-5.4 nano' },
  { id: 'gpt-5.2', label: 'GPT-5.2' },
  { id: 'o3', label: 'o3' },
  { id: 'o4-mini', label: 'o4-mini' }
] as const

const DEFAULT_MODEL = 'gpt-5.4'

const EFFORT_OPTIONS = [
  { id: 'none', label: 'None' },
  { id: 'minimal', label: 'Minimal' },
  { id: 'low', label: 'Low' },
  { id: 'medium', label: 'Medium' },
  { id: 'high', label: 'High' },
  { id: 'xhigh', label: 'Extra high' }
] as const

const VERBOSITY_OPTIONS = [
  { id: 'brief', label: 'Brief' },
  { id: 'normal', label: 'Normal' },
  { id: 'detailed', label: 'Detailed' }
] as const

type ModelId = (typeof GPT_MODELS)[number]['id']
type EffortLevel = (typeof EFFORT_OPTIONS)[number]['id']
type VerbosityLevel = (typeof VERBOSITY_OPTIONS)[number]['id']

interface GptContext {
  prompt: string
  pub: boolean
  model: ModelId
  effort: EffortLevel
  verbosity: VerbosityLevel
}

const GPT_CONTEXT_KEY = 'gpt-ctx'
const activeStreams = new Map<string, AbortController>()
const followUpIds = new Map<string, string[]>()

type AnyRow = ActionRowBuilder<StringSelectMenuBuilder> | ActionRowBuilder<ButtonBuilder>

type GptComponent = ContainerBuilder | AnyRow

function storeGptContext(token: string, ctx: GptContext) {
  setStoredValue(`${GPT_CONTEXT_KEY}:${token}`, JSON.stringify(ctx))
}

function loadGptContext(token: string): GptContext | null {
  const stored = getStoredValue(`${GPT_CONTEXT_KEY}:${token}`)
  if (!stored) return null
  try {
    return JSON.parse(stored) as GptContext
  } catch {
    return null
  }
}

function tokenFromId(customId: string, baseId: string): string | null {
  const prefix = `${baseId}:`
  if (!customId.startsWith(prefix)) return null
  return customId.slice(prefix.length)
}

function buildGptComponents(
  prompt: string,
  content: string,
  pub: boolean,
  token: string,
  model: string,
  effort: EffortLevel,
  verbosity: VerbosityLevel,
  streaming: boolean
): GptComponent[] {
  const displayContent = content ? (streaming ? `${content}\n-# ▌` : content) : '-# generating...'

  const ctr = new ContainerBuilder()
    .addTextDisplayComponents(new TextDisplayBuilder().setContent(`**${prompt}**`))
    .addSeparatorComponents(
      new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small).setDivider(true)
    )
    .addTextDisplayComponents(new TextDisplayBuilder().setContent(displayContent))

  const modelRow = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId(`${GPT_MODEL_SELECT_ID}:${token}`)
      .setPlaceholder(`Model: ${model}`)
      .addOptions(
        GPT_MODELS.map((m) => new StringSelectMenuOptionBuilder().setLabel(m.label).setValue(m.id))
      )
  )

  const components: GptComponent[] = [ctr]

  if (!pub) {
    components.push(
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
          .setCustomId(PIN_BUTTON_ID)
          .setLabel('Pin')
          .setStyle(ButtonStyle.Secondary),
        new ButtonBuilder()
          .setCustomId(PUB_BUTTON_ID)
          .setLabel('Publish')
          .setStyle(ButtonStyle.Success)
      ),
      modelRow,
      new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
        new StringSelectMenuBuilder()
          .setCustomId(`${GPT_EFFORT_SELECT_ID}:${token}`)
          .setPlaceholder(`Effort: ${effort}`)
          .addOptions(
            EFFORT_OPTIONS.map((e) =>
              new StringSelectMenuOptionBuilder().setLabel(e.label).setValue(e.id)
            )
          )
      ),
      new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
        new StringSelectMenuBuilder()
          .setCustomId(`${GPT_VERBOSITY_SELECT_ID}:${token}`)
          .setPlaceholder(`Verbosity: ${verbosity}`)
          .addOptions(
            VERBOSITY_OPTIONS.map((v) =>
              new StringSelectMenuOptionBuilder().setLabel(v.label).setValue(v.id)
            )
          )
      )
    )
  }

  return components
}

function buildFollowUpComponents(content: string, streaming: boolean): GptComponent[] {
  const displayContent = streaming ? `${content}\n-# ▌` : content

  return [
    new ContainerBuilder()
      .setAccentColor(GPT_COLOR)
      .addTextDisplayComponents(new TextDisplayBuilder().setContent(displayContent))
  ]
}

interface StreamCallbacks {
  editMain: (components: GptComponent[]) => Promise<{ id?: string } | unknown>
  followUp: (components: GptComponent[]) => Promise<{ id?: string } | unknown>
  editMessage: (messageId: string, components: GptComponent[]) => Promise<unknown>
  deleteMessage: (messageId: string) => Promise<unknown>
}

function makeCallbacks(
  interaction: {
    editReply: (options: { components: never; flags: number }) => Promise<unknown>
    followUp: (options: { components: never; flags: readonly number[] }) => Promise<unknown>
    webhook: {
      editMessage: (id: string, data: { components: never; flags: number }) => Promise<unknown>
      deleteMessage: (id: string) => Promise<unknown>
    }
  },
  pub: boolean
): StreamCallbacks {
  const msgFlags = pub
    ? MessageFlags.IsComponentsV2
    : MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral
  const followUpFlags: readonly number[] = pub
    ? [MessageFlags.IsComponentsV2]
    : [MessageFlags.IsComponentsV2, MessageFlags.Ephemeral]

  return {
    editMain: (comps) =>
      interaction.editReply({
        components: comps as never,
        flags: MessageFlags.IsComponentsV2
      }),
    followUp: (comps) => interaction.followUp({ components: comps as never, flags: followUpFlags }),
    editMessage: (id, comps) =>
      interaction.webhook.editMessage(id, {
        components: comps as never,
        flags: msgFlags
      }),
    deleteMessage: (id) => interaction.webhook.deleteMessage(id)
  }
}

async function runGptStream(
  callbacks: StreamCallbacks,
  ctx: GptContext,
  token: string
): Promise<void> {
  const apiKey = process.env.OPENAI_API_KEY
  if (!apiKey) {
    await callbacks.editMain(
      buildGptComponents(
        ctx.prompt,
        'no OPENAI_API_KEY',
        ctx.pub,
        token,
        ctx.model,
        ctx.effort,
        ctx.verbosity,
        false
      )
    )
    return
  }

  const existing = activeStreams.get(token)
  existing?.abort()

  const oldFollowUps = followUpIds.get(token) ?? []
  for (const id of oldFollowUps) {
    await callbacks.deleteMessage(id).catch(() => {})
  }
  followUpIds.set(token, [])

  const controller = new AbortController()
  activeStreams.set(token, controller)

  let currentPage = 1
  let currentPageContent = ''
  let lastEditTime = 0

  const editCurrentPage = async (content: string, streaming: boolean) => {
    if (currentPage === 1) {
      await callbacks.editMain(
        buildGptComponents(
          ctx.prompt,
          content,
          ctx.pub,
          token,
          ctx.model,
          ctx.effort,
          ctx.verbosity,
          streaming
        )
      )
    } else {
      const pageIds = followUpIds.get(token) ?? []
      const pageId = pageIds[currentPage - 2]
      if (pageId) {
        await callbacks.editMessage(pageId, buildFollowUpComponents(content, streaming))
      }
    }
  }

  const overflowToNewPage = async () => {
    await editCurrentPage(currentPageContent, false)
    currentPage++
    currentPageContent = ''

    const msg = (await callbacks.followUp(buildFollowUpComponents('-# generating...', true))) as {
      id?: string
    }

    if (msg?.id) {
      const ids = followUpIds.get(token) ?? []
      ids.push(msg.id)
      followUpIds.set(token, ids)
    }
  }

  try {
    const systemInstruction =
      ctx.verbosity === 'brief'
        ? 'Be concise and to the point. Keep responses short.'
        : ctx.verbosity === 'detailed'
          ? 'Be thorough and comprehensive. Explain in detail.'
          : null

    const model = new OpenAIModel({
      api: 'responses',
      modelId: ctx.model,
      apiKey,
      maxTokens: 4096,
      ...(ctx.effort !== 'none' ? { params: { reasoning: { effort: ctx.effort } } } : {})
    })
    const agent = new Agent({
      model,
      systemPrompt: systemInstruction ?? undefined,
      printer: false
    })

    for await (const event of agent.stream(ctx.prompt, {
      cancelSignal: controller.signal,
      limits: { turns: 1, outputTokens: 4096 }
    })) {
      if (controller.signal.aborted) break

      if (
        event.type === 'modelStreamUpdateEvent' &&
        event.event.type === 'modelContentBlockDeltaEvent' &&
        event.event.delta.type === 'textDelta'
      ) {
        currentPageContent += event.event.delta.text

        if (currentPageContent.length > PAGE_LIMIT) {
          const overflow = currentPageContent.slice(PAGE_LIMIT)
          currentPageContent = currentPageContent.slice(0, PAGE_LIMIT)
          await overflowToNewPage()
          currentPageContent = overflow
        }

        const now = Date.now()
        if (now - lastEditTime >= EDIT_INTERVAL_MS) {
          await editCurrentPage(currentPageContent, true)
          lastEditTime = now
        }
      }
    }

    if (!controller.signal.aborted) {
      await editCurrentPage(currentPageContent || '(no response)', false)
    }
  } catch (error) {
    if (
      error instanceof Error &&
      (error.name === 'AbortError' || error.message.includes('abort'))
    ) {
      return
    }

    const errMsg = error instanceof Error ? error.message : 'unknown error'
    await callbacks.editMain(
      buildGptComponents(
        ctx.prompt,
        `error: ${errMsg}`,
        ctx.pub,
        token,
        ctx.model,
        ctx.effort,
        ctx.verbosity,
        false
      )
    )
  } finally {
    activeStreams.delete(token)
  }
}

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
    await interaction.reply(container('gpt', new Map(), 'session expired'))
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
      updatedCtx.pub,
      token,
      updatedCtx.model,
      updatedCtx.effort,
      updatedCtx.verbosity,
      true
    )
  )

  await runGptStream(callbacks, updatedCtx, token)
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

export async function handleAgentCommand(interaction: ChatInputCommandInteraction): Promise<void> {
  const prompt = interaction.options.getString('prompt', true).trim()
  const model = DEFAULT_MODEL
  const pub = true
  const token = randomUUID().replace(/-/g, '').slice(0, 16)
  const ctx: GptContext = {
    prompt,
    pub,
    model,
    effort: 'medium',
    verbosity: 'normal'
  }
  storeGptContext(token, ctx)

  await interaction.deferReply()

  await interaction.editReply({
    components: buildGptComponents(
      prompt,
      '',
      pub,
      token,
      model,
      'medium',
      'normal',
      true
    ) as never,
    flags: MessageFlags.IsComponentsV2
  })

  const callbacks = makeCallbacks(interaction, pub)
  await runGptStream(callbacks, ctx, token)
}
