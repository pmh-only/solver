import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonInteraction,
  ButtonStyle,
  ContainerBuilder,
  MediaGalleryBuilder,
  MessageFlags,
  ModalBuilder,
  SectionBuilder,
  SeparatorBuilder,
  TextInputBuilder,
  TextInputStyle,
  TextDisplayBuilder
} from 'discord.js'
import type { CommandInteraction, CommandRunResult } from './types.js'
import type { Flags } from './flags.js'

export const PUB_BUTTON_ID = 'pub'
export const RETRY_BUTTON_ID = 'retry'
export const EDIT_PARAMETERS_BUTTON_ID = 'edit-parameters'
export const EDIT_PARAMETERS_MODAL_ID = 'edit-parameters'
export const EDIT_PARAMETERS_INPUT_ID = 'command'

const rerunnableInputs = new Map<string, string>()

export type TopLevelComponent =
  | string
  | TextDisplayBuilder
  | ContainerBuilder
  | SeparatorBuilder
  | SectionBuilder
  | MediaGalleryBuilder
  | ActionRowBuilder<ButtonBuilder>

function resolve(c: TopLevelComponent) {
  return typeof c === 'string' ? new TextDisplayBuilder().setContent(c) : c
}

function buildActionRow(pub: boolean, rerunnable: boolean) {
  const row = new ActionRowBuilder<ButtonBuilder>()

  if (rerunnable) {
    row.addComponents(
      new ButtonBuilder()
        .setCustomId(RETRY_BUTTON_ID)
        .setLabel('Retry')
        .setStyle(ButtonStyle.Secondary),
      new ButtonBuilder()
        .setCustomId(EDIT_PARAMETERS_BUTTON_ID)
        .setLabel('Edit parameters')
        .setStyle(ButtonStyle.Secondary)
    )
  }

  if (!pub) {
    row.addComponents(
      new ButtonBuilder().setCustomId(PUB_BUTTON_ID).setLabel('pub').setStyle(ButtonStyle.Secondary)
    )
  }

  return row.components.length > 0 ? row : null
}

function buildContainer(
  args: string,
  flags: Flags,
  rerunnable: boolean,
  components: TopLevelComponent[]
) {
  const pub = flags.has('pub')
  const flagsStr = [...flags.entries()]
    .map(([k, v]) => (v === true ? `--${k}` : `--${k} ${v}`))
    .join(' ')
  const footer = `-# \`${[args, flagsStr].filter(Boolean).join(' ')}\``
  const resolved = components.map(resolve)
  const last = resolved.at(-1)
  if (last instanceof TextDisplayBuilder) {
    last.setContent(`${last.data.content}\n${footer}`)
  } else {
    resolved.push(new TextDisplayBuilder().setContent(footer))
  }

  const actionRow = buildActionRow(pub, rerunnable)
  return {
    components: actionRow ? [...resolved, actionRow] : resolved,
    flags: pub
      ? ([MessageFlags.IsComponentsV2] as const)
      : ([MessageFlags.IsComponentsV2, MessageFlags.Ephemeral] as const)
  }
}

export function container(args: string, flags: Flags, ...components: TopLevelComponent[]) {
  return buildContainer(args, flags, false, components)
}

export function rerunnableContainer(
  args: string,
  flags: Flags,
  ...components: TopLevelComponent[]
) {
  return buildContainer(args, flags, true, components)
}

function toComponents(result: CommandRunResult): TopLevelComponent[] {
  return Array.isArray(result) ? result : [result]
}

export async function runRerunnableCommand(
  interaction: CommandInteraction,
  args: string,
  flags: Flags,
  run: () => Promise<CommandRunResult>
) {
  await interaction.deferReply({ flags: flags.has('pub') ? undefined : MessageFlags.Ephemeral })
  const result = await run()
  const reply = rerunnableContainer(args, flags, ...toComponents(result))
  const message = (await interaction.editReply({
    components: reply.components,
    flags: MessageFlags.IsComponentsV2
  })) as { id?: string }

  if (typeof message.id === 'string') {
    rerunnableInputs.set(
      message.id,
      `${args}${[...flags.entries()]
        .map(([k, v]) => (v === true ? ` --${k}` : ` --${k} ${v}`))
        .join('')}`
    )
  }
}

export function buildEditParametersModal(value: string) {
  return new ModalBuilder()
    .setCustomId(EDIT_PARAMETERS_MODAL_ID)
    .setTitle('Edit parameters')
    .addComponents(
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder()
          .setCustomId(EDIT_PARAMETERS_INPUT_ID)
          .setLabel('Command input')
          .setStyle(TextInputStyle.Paragraph)
          .setMaxLength(4000)
          .setRequired(true)
          .setValue(value.slice(0, 4000))
      )
    )
}

function collectContentValues(node: unknown, values: string[]) {
  if (!node || typeof node !== 'object') return

  const record = node as { content?: unknown; components?: unknown }
  if (typeof record.content === 'string') {
    values.push(record.content)
  }

  if (Array.isArray(record.components)) {
    for (const component of record.components) {
      collectContentValues(component, values)
    }
  }
}

export function extractCommandInputFromComponents(components: unknown): string | null {
  const values: string[] = []
  collectContentValues(components, values)

  let command: string | null = null
  for (const value of values) {
    for (const match of value.matchAll(/-# `([^`]+)`/g)) {
      command = match[1]
    }
  }

  return command
}

export function extractCommandInputFromMessage(interaction: ButtonInteraction): string | null {
  const remembered = rerunnableInputs.get(interaction.message.id)
  if (remembered) return remembered

  const direct = extractCommandInputFromComponents(interaction.message.components)
  if (direct) return direct

  const message = interaction.message.toJSON() as { components?: unknown }
  return extractCommandInputFromComponents(message.components)
}
