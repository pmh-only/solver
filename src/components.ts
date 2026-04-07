import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonInteraction,
  ButtonStyle,
  ContainerBuilder,
  LabelBuilder,
  MediaGalleryBuilder,
  MessageFlags,
  ModalBuilder,
  SectionBuilder,
  SeparatorBuilder,
  SeparatorSpacingSize,
  StringSelectMenuBuilder,
  StringSelectMenuOptionBuilder,
  StringSelectMenuInteraction,
  TextInputBuilder,
  TextInputStyle,
  TextDisplayBuilder
} from 'discord.js'
import type { CommandInteraction, CommandRunResult, Subcommand } from './types.js'
import type { Flags } from './flags.js'

export const PUB_BUTTON_ID = 'pub'
export const RETRY_BUTTON_ID = 'retry'
export const EDIT_PARAMETERS_BUTTON_ID = 'edit-parameters'
export const EDIT_PARAMETERS_MODAL_ID = 'edit-parameters'
export const EDIT_PARAMETERS_INPUT_ID = 'command'
export const COMMAND_ACTION_SELECT_ID = 'command-actions'
export const COMMAND_PRESET_SELECT_ID = 'command-presets'

type ReferenceView = 'usage' | 'examples' | 'flags'
type ReplyTone = 'default' | 'success' | 'warning' | 'danger'

const COMMAND_COLORS: Record<string, number> = {
  ping: 0x3b82f6,
  whois: 0x8b5cf6,
  dig: 0x22c55e,
  conv: 0xa855f7,
  math: 0x06b6d4,
  set: 0x14b8a6,
  get: 0x64748b,
  curl: 0xf59e0b,
  cert: 0x0ea5e9,
  geoip: 0xec4899,
  run: 0xf97316,
  sh: 0xef4444
}

const TONE_COLORS: Record<Exclude<ReplyTone, 'default'>, number> = {
  success: 0x22c55e,
  warning: 0xf59e0b,
  danger: 0xef4444
}

const rerunnableInputs = new Map<string, string>()

export type TopLevelComponent =
  | string
  | TextDisplayBuilder
  | SeparatorBuilder
  | SectionBuilder
  | MediaGalleryBuilder

interface CommandReplyOptions {
  subcommand?: Pick<Subcommand, 'name' | 'description' | 'flags' | 'usage' | 'examples'>
  tone?: ReplyTone
}

function resolve(c: TopLevelComponent) {
  return typeof c === 'string' ? text(c) : c
}

function truncate(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max - 1)}...` : value
}

function commandName(args: string): string {
  return args.trim().split(/\s+/)[0]?.toLowerCase() ?? ''
}

function footerText(args: string, flags: Flags): string {
  const flagsStr = [...flags.entries()]
    .map(([k, v]) => (v === true ? `--${k}` : `--${k} ${v}`))
    .join(' ')
  return `-# \`${[args, flagsStr].filter(Boolean).join(' ')}\``
}

function accentColor(args: string, tone: ReplyTone): number {
  if (tone !== 'default') return TONE_COLORS[tone]
  return COMMAND_COLORS[commandName(args)] ?? 0x5865f2
}

function addComponent(container: ContainerBuilder, component: TopLevelComponent) {
  const resolved = resolve(component)

  if (resolved instanceof TextDisplayBuilder) {
    container.addTextDisplayComponents(resolved)
    return
  }

  if (resolved instanceof SeparatorBuilder) {
    container.addSeparatorComponents(resolved)
    return
  }

  if (resolved instanceof SectionBuilder) {
    container.addSectionComponents(resolved)
    return
  }

  if (resolved instanceof MediaGalleryBuilder) {
    container.addMediaGalleryComponents(resolved)
  }
}

function buildButtonRow(pub: boolean, includeCommandActions: boolean) {
  const row = new ActionRowBuilder<ButtonBuilder>()

  if (includeCommandActions) {
    row.addComponents(
      new ButtonBuilder()
        .setCustomId(RETRY_BUTTON_ID)
        .setLabel('Retry')
        .setStyle(ButtonStyle.Primary),
      new ButtonBuilder()
        .setCustomId(EDIT_PARAMETERS_BUTTON_ID)
        .setLabel('Edit parameters')
        .setStyle(ButtonStyle.Secondary)
    )
  }

  if (!pub) {
    row.addComponents(
      new ButtonBuilder()
        .setCustomId(PUB_BUTTON_ID)
        .setLabel('Publish')
        .setStyle(ButtonStyle.Success)
    )
  }

  return row.components.length > 0 ? row : null
}

function buildReferenceRow(
  subcommand?: Pick<Subcommand, 'description' | 'examples' | 'flags' | 'name' | 'usage'>
) {
  if (!subcommand) return null

  const select = new StringSelectMenuBuilder()
    .setCustomId(COMMAND_ACTION_SELECT_ID)
    .setPlaceholder('Open command reference')
    .addOptions(
      new StringSelectMenuOptionBuilder()
        .setLabel('Usage')
        .setValue('usage')
        .setDescription('Show syntax and the fastest path'),
      new StringSelectMenuOptionBuilder()
        .setLabel('Examples')
        .setValue('examples')
        .setDescription('Show runnable sample inputs')
    )

  if (subcommand.flags && Object.keys(subcommand.flags).length > 0) {
    select.addOptions(
      new StringSelectMenuOptionBuilder()
        .setLabel('Flags')
        .setValue('flags')
        .setDescription('Inspect supported flags')
    )
  }

  return new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(select)
}

function buildPresetRow(subcommand?: Pick<Subcommand, 'examples' | 'name'>) {
  if (!subcommand?.examples?.length) return null

  const select = new StringSelectMenuBuilder()
    .setCustomId(COMMAND_PRESET_SELECT_ID)
    .setPlaceholder('Run a preset')
    .addOptions(
      subcommand.examples.slice(0, 25).map((example, index) =>
        new StringSelectMenuOptionBuilder()
          .setLabel(truncate(`${index + 1}. ${example}`, 100))
          .setValue(example)
          .setDescription(truncate(`Run ${subcommand.name} with this input`, 100))
      )
    )

  return new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(select)
}

function controlRows(
  pub: boolean,
  subcommand?: Pick<Subcommand, 'description' | 'examples' | 'flags' | 'name' | 'usage'>
) {
  const rows = [
    buildButtonRow(pub, Boolean(subcommand)),
    buildReferenceRow(subcommand),
    buildPresetRow(subcommand)
  ].filter(
    (row): row is ActionRowBuilder<ButtonBuilder> | ActionRowBuilder<StringSelectMenuBuilder> =>
      Boolean(row)
  )

  return rows
}

function buildContainer(
  args: string,
  flags: Flags,
  components: TopLevelComponent[],
  options: CommandReplyOptions = {}
) {
  const pub = flags.has('pub')
  const resolved = components.map(resolve)
  const footer = footerText(args, flags)
  const last = resolved.at(-1)

  if (last instanceof TextDisplayBuilder) {
    last.setContent(`${last.data.content ?? ''}\n\n${footer}`)
  } else {
    resolved.push(text(footer))
  }

  const body = new ContainerBuilder().setAccentColor(accentColor(args, options.tone ?? 'default'))
  for (const component of resolved) {
    addComponent(body, component)
  }

  return {
    components: [body, ...controlRows(pub, options.subcommand)],
    flags: pub
      ? ([MessageFlags.IsComponentsV2] as const)
      : ([MessageFlags.IsComponentsV2, MessageFlags.Ephemeral] as const)
  }
}

function formatFlagLine(name: string, def: NonNullable<Subcommand['flags']>[string]): string {
  const value = def.value ? ' <value>' : ''
  const alias = def.alias ? ` / -${def.alias}` : ''
  return `- \`--${name}${value}\`${alias ? ` (${alias})` : ''} ${def.description}`
}

export function container(args: string, flags: Flags, ...components: TopLevelComponent[]) {
  return buildContainer(args, flags, components)
}

export function commandContainer(
  subcommand: Pick<Subcommand, 'name' | 'description' | 'flags' | 'usage' | 'examples'>,
  args: string,
  flags: Flags,
  ...components: TopLevelComponent[]
) {
  return buildContainer(args, flags, components, { subcommand })
}

export function text(content: string) {
  return new TextDisplayBuilder().setContent(content)
}

export function separator(spacing = SeparatorSpacingSize.Small, divider = true) {
  return new SeparatorBuilder().setSpacing(spacing).setDivider(divider)
}

export function codeBlock(label: string, body: string, language = 'txt') {
  return text(`**${label}**\n\n\`\`\`${language}\n${body}\n\`\`\``)
}

export function bulletBlock(title: string, items: string[], empty = '-# none') {
  return text(
    [`**${title}**`, ...(items.length > 0 ? items.map((item) => `- ${item}`) : [empty])].join('\n')
  )
}

export function keyValueBlock(
  title: string,
  entries: Array<[string, string | number | boolean | null | undefined]>,
  empty = '-# none'
) {
  const lines = entries
    .filter(([, value]) => value !== null && value !== undefined && value !== '')
    .map(([label, value]) => `- **${label}:** ${String(value)}`)

  return text([`**${title}**`, ...(lines.length > 0 ? lines : [empty])].join('\n'))
}

export function summarySection(
  title: string,
  lines: string[],
  link?: { label: string; url: string }
) {
  if (!link) {
    return text([`## ${title}`, ...lines].join('\n'))
  }

  const section = new SectionBuilder().addTextDisplayComponents(text(`## ${title}`))
  if (lines.length > 0) {
    section.addTextDisplayComponents(text(lines.join('\n')))
  }

  section.setButtonAccessory(
    new ButtonBuilder().setStyle(ButtonStyle.Link).setLabel(link.label).setURL(link.url)
  )

  return section
}

function syntaxLine(subcommand: Pick<Subcommand, 'name' | 'usage'>) {
  return subcommand.usage ?? `${subcommand.name} <args>`
}

function commandReferenceComponents(
  subcommand: Pick<Subcommand, 'name' | 'description' | 'flags' | 'usage' | 'examples'>,
  view: ReferenceView,
  detail?: string
) {
  const components: TopLevelComponent[] = [
    summarySection(
      view === 'usage'
        ? `${subcommand.name} usage`
        : view === 'examples'
          ? `${subcommand.name} examples`
          : `${subcommand.name} flags`,
      [subcommand.description, ...(detail ? [`**${detail}**`] : [])]
    )
  ]

  if (view === 'usage') {
    components.push(separator(), text(`**Syntax**\n\`${syntaxLine(subcommand)}\``))

    if (subcommand.examples?.length) {
      components.push(
        text(
          [
            '**Examples**',
            ...subcommand.examples
              .slice(0, 5)
              .map((example, index) => `${index + 1}. \`${example}\``)
          ].join('\n')
        )
      )
    }

    if (subcommand.flags && Object.keys(subcommand.flags).length > 0) {
      components.push(
        text(
          [
            '**Key flags**',
            ...Object.entries(subcommand.flags)
              .slice(0, 5)
              .map(([name, def]) => formatFlagLine(name, def))
          ].join('\n')
        )
      )
    }
  }

  if (view === 'examples') {
    components.push(
      separator(),
      text(
        subcommand.examples?.length
          ? [
              '**Try one of these**',
              ...subcommand.examples
                .slice(0, 10)
                .map((example, index) => `${index + 1}. \`${example}\``)
            ].join('\n')
          : '**Try one of these**\n-# no examples'
      ),
      text(`**Syntax**\n\`${syntaxLine(subcommand)}\``)
    )
  }

  if (view === 'flags') {
    components.push(
      separator(),
      text(
        subcommand.flags && Object.keys(subcommand.flags).length > 0
          ? [
              '**Supported flags**',
              ...Object.entries(subcommand.flags).map(([name, def]) => formatFlagLine(name, def))
            ].join('\n')
          : '**Supported flags**\n-# none'
      ),
      text(`**Syntax**\n\`${syntaxLine(subcommand)}\``)
    )
  }

  return components
}

export function commandReferenceReply(
  subcommand: Pick<Subcommand, 'name' | 'description' | 'flags' | 'usage' | 'examples'>,
  args: string,
  flags: Flags,
  view: ReferenceView,
  detail?: string
) {
  return buildContainer(args, flags, commandReferenceComponents(subcommand, view, detail), {
    subcommand,
    tone: detail ? 'warning' : 'default'
  })
}

export async function deferCommandResponse(interaction: CommandInteraction, flags: Flags) {
  if (interaction.isButton() || interaction.isStringSelectMenu()) {
    await interaction.deferUpdate()
    return
  }

  if (interaction.isModalSubmit() && 'message' in interaction && interaction.message) {
    await interaction.deferUpdate()
    return
  }

  await interaction.deferReply({ flags: flags.has('pub') ? undefined : MessageFlags.Ephemeral })
}

export async function sendCommandReply(
  interaction: CommandInteraction,
  payload: ReturnType<typeof container>
) {
  if (interaction.deferred) {
    await interaction.editReply({
      components: payload.components,
      flags: MessageFlags.IsComponentsV2
    })
    return
  }

  if (interaction.isButton() || interaction.isStringSelectMenu()) {
    await interaction.update({
      components: payload.components,
      flags: MessageFlags.IsComponentsV2
    })
    return
  }

  if (interaction.isModalSubmit() && 'message' in interaction && interaction.message) {
    await interaction.deferUpdate()
    await interaction.editReply({
      components: payload.components,
      flags: MessageFlags.IsComponentsV2
    })
    return
  }

  await interaction.reply(payload)
}

function toComponents(result: CommandRunResult): TopLevelComponent[] {
  return Array.isArray(result) ? result : [result]
}

export async function runRerunnableCommand(
  interaction: CommandInteraction,
  subcommand: Pick<Subcommand, 'name' | 'description' | 'flags' | 'usage' | 'examples'>,
  args: string,
  flags: Flags,
  run: () => Promise<CommandRunResult>
) {
  await deferCommandResponse(interaction, flags)
  const result = await run()
  const reply = commandContainer(subcommand, args, flags, ...toComponents(result))
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
      new LabelBuilder()
        .setLabel('Command input')
        .setDescription('Edit the full /c input, then submit to rerun it.')
        .setTextInputComponent(
          new TextInputBuilder()
            .setCustomId(EDIT_PARAMETERS_INPUT_ID)
            .setStyle(TextInputStyle.Paragraph)
            .setMaxLength(4000)
            .setRequired(true)
            .setValue(value.slice(0, 4000))
            .setPlaceholder('ping 1.1.1.1 --count 5')
        )
    )
}

function collectContentValues(node: unknown, values: string[]) {
  if (!node || typeof node !== 'object') return

  const record = node as {
    accessory?: unknown
    component?: unknown
    content?: unknown
    components?: unknown
  }
  if (typeof record.content === 'string') {
    values.push(record.content)
  }

  if (Array.isArray(record.components)) {
    for (const component of record.components) {
      collectContentValues(component, values)
    }
  }

  collectContentValues(record.accessory, values)
  collectContentValues(record.component, values)
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

export function extractCommandInputFromMessage(
  interaction: ButtonInteraction | StringSelectMenuInteraction
): string | null {
  const remembered = rerunnableInputs.get(interaction.message.id)
  if (remembered) return remembered

  const direct = extractCommandInputFromComponents(interaction.message.components)
  if (direct) return direct

  const message = interaction.message.toJSON() as { components?: unknown }
  return extractCommandInputFromComponents(message.components)
}
