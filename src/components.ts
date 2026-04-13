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
import { randomUUID } from 'node:crypto'
import type { CommandInteraction, CommandRunResult, Subcommand } from './types.js'
import type { Flags } from './flags.js'
import { getStoredValue, setStoredValue } from './helpers/kv-store.js'

export const PUB_BUTTON_ID = 'pub'
export const PUB_CONTENT_BUTTON_ID = 'pub-content'
export const PIN_BUTTON_ID = 'pin'
export const RETRY_BUTTON_ID = 'retry'
export const EDIT_PARAMETERS_BUTTON_ID = 'edit-parameters'
export const EDIT_PARAMETERS_MODAL_ID = 'edit-parameters'
export const EDIT_PARAMETERS_INPUT_ID = 'command'
export const COMMAND_ACTION_SELECT_ID = 'command-actions'
export const COMMAND_PRESET_SELECT_ID = 'command-presets'
export const COMMAND_RUN_BUTTON_ID = 'run-command'
export const COMMAND_RUN_MODAL_ID = 'run-command-modal'
export const COMMAND_RUN_INPUT_ID = 'run-command-args'

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
  sh: 0xef4444,
  mail: 0x2563eb,
  gpt: 0x10a37f
}

const TONE_COLORS: Record<Exclude<ReplyTone, 'default'>, number> = {
  success: 0x22c55e,
  warning: 0xf59e0b,
  danger: 0xef4444
}

const COMMAND_INPUT_KEY = 'command-input'
const MESSAGE_INPUT_KEY = 'message-input'
const CONSTRAINED_COMMAND_KEY = 'constrained-command'
const EPHEMERAL_REPLY_TTL_MS = 60_000

interface ConstrainedCommandTemplate {
  command: string
  args: string
}

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

interface PlainTextReplyPayload {
  content: string
  components?: ActionRowBuilder<ButtonBuilder>[]
  flags?: number | readonly number[]
}

type DeleteReplyCapable = {
  deleteReply(): Promise<unknown>
}

type DeleteMessageCapable = {
  deleteMessage(message: string): Promise<unknown>
}

const ephemeralDeleteTimers = new Map<string, ReturnType<typeof setTimeout>>()

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
  return `-# \`${serializeCommandInput(args, flags)}\``
}

function serializeCommandInput(args: string, flags: Flags): string {
  const flagsStr = [...flags.entries()]
    .map(([k, v]) => (v === true ? `--${k}` : `--${k} ${v}`))
    .join(' ')
  return [args, flagsStr].filter(Boolean).join(' ')
}

function commandInputKey(prefix: string, value: string): string {
  return `${prefix}:${value}`
}

function storeCommandInput(key: string, value: string) {
  setStoredValue(key, value)
}

function loadCommandInput(key: string): string | null {
  return getStoredValue(key) ?? null
}

function buildCommandComponentId(baseId: string, commandInput?: string): string {
  if (!commandInput) return baseId

  const token = randomUUID().replace(/-/g, '').slice(0, 16)
  storeCommandInput(commandInputKey(COMMAND_INPUT_KEY, token), commandInput)
  return `${baseId}:${token}`
}

export function commandRunButton(label: string, commandInput: string, style = ButtonStyle.Primary) {
  return new ButtonBuilder()
    .setCustomId(buildCommandComponentId(COMMAND_RUN_BUTTON_ID, commandInput))
    .setLabel(label)
    .setStyle(style)
}

export function constrainedCommandButton(
  label: string,
  template: ConstrainedCommandTemplate,
  style = ButtonStyle.Primary
) {
  const token = randomUUID().replace(/-/g, '').slice(0, 16)
  storeCommandInput(commandInputKey(CONSTRAINED_COMMAND_KEY, token), JSON.stringify(template))

  return new ButtonBuilder()
    .setCustomId(`${COMMAND_RUN_BUTTON_ID}:${token}`)
    .setLabel(label)
    .setStyle(style)
}

export function matchesInteractiveId(customId: string, baseId: string): boolean {
  return customId === baseId || customId.startsWith(`${baseId}:`)
}

function extractStoredCommandInput(customId: string): string | null {
  for (const baseId of [
    RETRY_BUTTON_ID,
    EDIT_PARAMETERS_BUTTON_ID,
    COMMAND_ACTION_SELECT_ID,
    COMMAND_RUN_BUTTON_ID
  ]) {
    const prefix = `${baseId}:`
    if (!customId.startsWith(prefix)) continue

    return loadCommandInput(commandInputKey(COMMAND_INPUT_KEY, customId.slice(prefix.length)))
  }

  return null
}

function rememberCommandInputForMessage(messageId: string, commandInput: string) {
  storeCommandInput(commandInputKey(MESSAGE_INPUT_KEY, messageId), commandInput)
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

function pinButton() {
  return new ButtonBuilder()
    .setCustomId(PIN_BUTTON_ID)
    .setLabel('Pin')
    .setStyle(ButtonStyle.Secondary)
}

export function publishButtonRow() {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    pinButton(),
    new ButtonBuilder().setCustomId(PUB_BUTTON_ID).setLabel('Publish').setStyle(ButtonStyle.Success)
  )
}

export function pinButtonRow() {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(pinButton())
}

const CONTENT_PUBLISH_KEY = 'pub-content'

export function contentPublishButtonRow(content: string) {
  const token = randomUUID().replace(/-/g, '').slice(0, 16)
  storeCommandInput(commandInputKey(CONTENT_PUBLISH_KEY, token), content)
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    pinButton(),
    new ButtonBuilder()
      .setCustomId(`${PUB_CONTENT_BUTTON_ID}:${token}`)
      .setLabel('Publish')
      .setStyle(ButtonStyle.Success)
  )
}

export function loadContentPublishValue(customId: string): string | null {
  const prefix = `${PUB_CONTENT_BUTTON_ID}:`
  if (!customId.startsWith(prefix)) return null
  return loadCommandInput(commandInputKey(CONTENT_PUBLISH_KEY, customId.slice(prefix.length)))
}

function buildButtonRow(pub: boolean, includeCommandActions: boolean, commandInput?: string) {
  const row = new ActionRowBuilder<ButtonBuilder>()

  if (includeCommandActions) {
    row.addComponents(
      new ButtonBuilder()
        .setCustomId(buildCommandComponentId(RETRY_BUTTON_ID, commandInput))
        .setLabel('Retry')
        .setStyle(ButtonStyle.Primary),
      new ButtonBuilder()
        .setCustomId(buildCommandComponentId(EDIT_PARAMETERS_BUTTON_ID, commandInput))
        .setLabel('Edit parameters')
        .setStyle(ButtonStyle.Secondary)
    )
  }

  if (!pub) {
    row.addComponents(
      pinButton(),
      new ButtonBuilder()
        .setCustomId(PUB_BUTTON_ID)
        .setLabel('Publish')
        .setStyle(ButtonStyle.Success)
    )
  }

  return row.components.length > 0 ? row : null
}

function buildReferenceRow(
  subcommand?: Pick<Subcommand, 'description' | 'examples' | 'flags' | 'name' | 'usage'>,
  commandInput?: string
) {
  if (!subcommand) return null

  const select = new StringSelectMenuBuilder()
    .setCustomId(buildCommandComponentId(COMMAND_ACTION_SELECT_ID, commandInput))
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
  subcommand?: Pick<Subcommand, 'description' | 'examples' | 'flags' | 'name' | 'usage'>,
  commandInput?: string
) {
  const rows = [
    buildButtonRow(pub, Boolean(subcommand), commandInput),
    buildReferenceRow(subcommand, commandInput),
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
  const commandInput = options.subcommand ? serializeCommandInput(args, flags) : undefined
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
    components: pub ? [body] : [body, ...controlRows(pub, options.subcommand, commandInput)],
    commandInput,
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

export function pinnedMessageComponents(components: readonly { toJSON(): unknown }[]) {
  return components.map((component) => {
    const json = component.toJSON() as { components?: unknown[] }
    if (!Array.isArray(json.components)) return json

    return {
      ...json,
      components: json.components.map((entry) => {
        if (!entry || typeof entry !== 'object') return entry

        const button = entry as {
          custom_id?: unknown
          disabled?: unknown
          label?: unknown
          style?: unknown
        }

        if (button.custom_id !== PIN_BUTTON_ID) return entry

        return {
          ...button,
          disabled: true,
          label: 'Pinned',
          style: ButtonStyle.Secondary
        }
      })
    }
  })
}

export function hasEphemeralFlag(flags: number | readonly number[]) {
  if (Array.isArray(flags)) {
    return flags.includes(MessageFlags.Ephemeral)
  }

  return typeof flags === 'number' && Boolean(flags & MessageFlags.Ephemeral)
}

export function cancelEphemeralDelete(messageId: string) {
  const timer = ephemeralDeleteTimers.get(messageId)
  if (!timer) return false

  clearTimeout(timer)
  ephemeralDeleteTimers.delete(messageId)
  return true
}

function scheduleDelete(messageId: string, action: () => Promise<unknown>) {
  cancelEphemeralDelete(messageId)

  const timer = setTimeout(() => {
    ephemeralDeleteTimers.delete(messageId)
    void action().catch(() => {})
  }, EPHEMERAL_REPLY_TTL_MS)

  ephemeralDeleteTimers.set(messageId, timer)
  timer.unref?.()
}

export function scheduleEphemeralReplyDelete(
  interaction: DeleteReplyCapable,
  messageId: string,
  flags: number | readonly number[]
) {
  if (!hasEphemeralFlag(flags)) return

  scheduleDelete(messageId, () => interaction.deleteReply())
}

export function scheduleEphemeralMessageDelete(
  webhook: DeleteMessageCapable,
  messageId: string,
  flags: number | readonly number[]
) {
  if (!hasEphemeralFlag(flags)) return

  scheduleDelete(messageId, () => webhook.deleteMessage(messageId))
}

export async function deferCommandResponse(interaction: CommandInteraction, flags: Flags) {
  if (interaction.deferred || interaction.replied) {
    return
  }

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
    const message = (await interaction.editReply({
      components: payload.components,
      flags: MessageFlags.IsComponentsV2
    })) as { id?: string }
    if (typeof message.id === 'string') {
      scheduleEphemeralReplyDelete(interaction, message.id, payload.flags)
    }
    if (payload.commandInput && typeof message.id === 'string') {
      rememberCommandInputForMessage(message.id, payload.commandInput)
    }
    return
  }

  if (interaction.isButton() || interaction.isStringSelectMenu()) {
    await interaction.update({
      components: payload.components,
      flags: MessageFlags.IsComponentsV2
    })
    scheduleEphemeralReplyDelete(interaction, interaction.message.id, payload.flags)
    if (payload.commandInput) {
      rememberCommandInputForMessage(interaction.message.id, payload.commandInput)
    }
    return
  }

  if (interaction.isModalSubmit() && 'message' in interaction && interaction.message) {
    await interaction.deferUpdate()
    const message = (await interaction.editReply({
      components: payload.components,
      flags: MessageFlags.IsComponentsV2
    })) as { id?: string }
    const messageId = typeof message.id === 'string' ? message.id : interaction.message.id
    scheduleEphemeralReplyDelete(interaction, messageId, payload.flags)
    if (payload.commandInput) {
      rememberCommandInputForMessage(messageId, payload.commandInput)
    }
    return
  }

  await interaction.reply(payload)
  if (payload.commandInput || hasEphemeralFlag(payload.flags)) {
    const message = (await interaction.fetchReply()) as { id?: string }
    if (typeof message.id === 'string') {
      scheduleEphemeralReplyDelete(interaction, message.id, payload.flags)
    }
    if (payload.commandInput && typeof message.id === 'string') {
      rememberCommandInputForMessage(message.id, payload.commandInput)
    }
  }
}

export async function sendPlainTextReply(
  interaction: CommandInteraction,
  payload: PlainTextReplyPayload
) {
  if (interaction.deferred) {
    const message = (await interaction.editReply({
      content: payload.content,
      components: payload.components
    })) as { id?: string }
    if (typeof message.id === 'string') {
      scheduleEphemeralReplyDelete(interaction, message.id, payload.flags ?? 0)
    }
    return
  }

  if (interaction.isButton() || interaction.isStringSelectMenu()) {
    await interaction.update({
      content: payload.content,
      components: payload.components
    })
    scheduleEphemeralReplyDelete(interaction, interaction.message.id, payload.flags ?? 0)
    return
  }

  if (interaction.isModalSubmit() && 'message' in interaction && interaction.message) {
    await interaction.deferUpdate()
    const message = (await interaction.editReply({
      content: payload.content,
      components: payload.components
    })) as { id?: string }
    const messageId = typeof message.id === 'string' ? message.id : interaction.message.id
    scheduleEphemeralReplyDelete(interaction, messageId, payload.flags ?? 0)
    return
  }

  await interaction.reply(payload)
  if (hasEphemeralFlag(payload.flags ?? 0)) {
    const message = (await interaction.fetchReply()) as { id?: string }
    if (typeof message.id === 'string') {
      scheduleEphemeralReplyDelete(interaction, message.id, payload.flags ?? 0)
    }
  }
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
    scheduleEphemeralReplyDelete(interaction, message.id, reply.flags)
    rememberCommandInputForMessage(message.id, serializeCommandInput(args, flags))
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

export function loadConstrainedCommandTemplate(
  customId: string
): ConstrainedCommandTemplate | null {
  const prefix = `${COMMAND_RUN_BUTTON_ID}:`
  const modalPrefix = `${COMMAND_RUN_MODAL_ID}:`
  const token = customId.startsWith(prefix)
    ? customId.slice(prefix.length)
    : customId.startsWith(modalPrefix)
      ? customId.slice(modalPrefix.length)
      : null

  if (!token) return null

  const stored = loadCommandInput(commandInputKey(CONSTRAINED_COMMAND_KEY, token))
  if (!stored) return null

  try {
    const parsed = JSON.parse(stored) as Partial<ConstrainedCommandTemplate>
    if (typeof parsed.command !== 'string' || typeof parsed.args !== 'string') return null
    return parsed as ConstrainedCommandTemplate
  } catch {
    return null
  }
}

export function buildConstrainedCommandModal(
  customId: string,
  template: ConstrainedCommandTemplate
) {
  return new ModalBuilder()
    .setCustomId(customId.replace(`${COMMAND_RUN_BUTTON_ID}:`, `${COMMAND_RUN_MODAL_ID}:`))
    .setTitle(`Run ${template.command}`)
    .addComponents(
      new LabelBuilder()
        .setLabel('Arguments')
        .setDescription(
          `Only ${template.command} arguments can be edited. This always runs publicly.`
        )
        .setTextInputComponent(
          new TextInputBuilder()
            .setCustomId(COMMAND_RUN_INPUT_ID)
            .setStyle(TextInputStyle.Paragraph)
            .setMaxLength(4000)
            .setRequired(true)
            .setValue(template.args.slice(0, 4000))
            .setPlaceholder(template.args.slice(0, 100) || 'arguments')
        )
    )
}

export function buildConstrainedCommandInput(
  template: ConstrainedCommandTemplate,
  input: string
): string {
  const args = input.trim()
  return [template.command, args, '--pub'].filter(Boolean).join(' ')
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
  const encoded = extractStoredCommandInput(interaction.customId)
  if (encoded) return encoded

  const remembered = loadCommandInput(commandInputKey(MESSAGE_INPUT_KEY, interaction.message.id))
  if (remembered) return remembered

  const direct = extractCommandInputFromComponents(interaction.message.components)
  if (direct) return direct

  const message = interaction.message.toJSON() as { components?: unknown }
  return extractCommandInputFromComponents(message.components)
}
