import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ContainerBuilder,
  MessageFlags,
  SeparatorBuilder,
  SeparatorSpacingSize,
  TextDisplayBuilder,
  type ButtonInteraction
} from 'discord.js'
import { randomUUID } from 'node:crypto'
import type { Subcommand } from '../types.js'
import { getStoredValue, setStoredValue } from '../helpers/kv-store.js'
import { isPubtabContext } from '../flags.js'
import { withPubtabButton } from '../components.js'

export const SLOTS_SPIN_BUTTON_ID = 'slots-spin'

const SLOTS_COLOR = 0xf59e0b
const SLOTS_STATE_KEY = 'slots'
const SLOT_SYMBOLS = ['🍒', '🍋', '🍉', '⭐', '🔔'] as const
const SLOT_REEL_COUNT = 3

type SlotSymbol = (typeof SLOT_SYMBOLS)[number]
type SlotState = [SlotSymbol, SlotSymbol, SlotSymbol]

interface SlotsState {
  commandInput: string
  pub: boolean
  pubtab: boolean
  lastSpin?: [SlotSymbol, SlotSymbol, SlotSymbol]
  pulls?: number
  lastPlayer: string
}

type SlotsComponent = ContainerBuilder | ActionRowBuilder<ButtonBuilder>

function stateKey(token: string): string {
  return `${SLOTS_STATE_KEY}:${token}`
}

function storeState(token: string, state: SlotsState): void {
  setStoredValue(stateKey(token), JSON.stringify(state))
}

function isSlotSymbol(value: unknown): value is SlotSymbol {
  return typeof value === 'string' && (SLOT_SYMBOLS as readonly string[]).includes(value)
}

function parseSpin(value: unknown): SlotState | undefined {
  if (!Array.isArray(value) || value.length !== SLOT_REEL_COUNT) return undefined
  const [a, b, c] = value
  if (!isSlotSymbol(a) || !isSlotSymbol(b) || !isSlotSymbol(c)) return undefined
  return [a, b, c]
}

function loadState(token: string): SlotsState | null {
  const stored = getStoredValue(stateKey(token))
  if (!stored) return null

  try {
    const parsed = JSON.parse(stored) as Partial<SlotsState>
    if (typeof parsed.lastPlayer !== 'string' || !parsed.lastPlayer) return null
    if (typeof parsed.commandInput !== 'string') return null

    return {
      commandInput: parsed.commandInput,
      pub: Boolean(parsed.pub),
      pubtab: Boolean(parsed.pubtab),
      pulls: Number.isFinite(parsed.pulls) && typeof parsed.pulls === 'number' && Number.isInteger(parsed.pulls) ? parsed.pulls : 0,
      lastPlayer: parsed.lastPlayer,
      lastSpin: parseSpin(parsed.lastSpin)
    }
  } catch {
    return null
  }
}

function randomSymbol(): SlotSymbol {
  return SLOT_SYMBOLS[Math.floor(Math.random() * SLOT_SYMBOLS.length)]
}

function spinResult(): SlotState {
  return [randomSymbol(), randomSymbol(), randomSymbol()]
}

function parseSpinId(customId: string): string | null {
  const [base, token] = customId.split(':')
  return base === SLOTS_SPIN_BUTTON_ID && token ? token : null
}

function displayName(interaction: ButtonInteraction): string {
  return interaction.user.globalName ?? interaction.user.username
}

function isJackpot(spin: SlotState): boolean {
  return spin[0] === spin[1] && spin[1] === spin[2]
}

function outcomeLines(state: SlotsState): string[] {
  if (!state.lastSpin) {
    return ['Press Spin to pull the lever.', 'A pull can never be too bold.']
  }

  const [first, second, third] = state.lastSpin
  return [
    `Pull #${state.pulls ?? 0} by ${state.lastPlayer}`,
    `🎰 ${first} ${second} ${third}`,
    isJackpot(state.lastSpin) ? 'Jackpot! Triple match.' : 'Not a jackpot this pull.'
  ]
}

function buildSpinButton(token: string, disabled: boolean): ButtonBuilder {
  return new ButtonBuilder()
    .setCustomId(`${SLOTS_SPIN_BUTTON_ID}:${token}`)
    .setLabel('Spin')
    .setStyle(ButtonStyle.Success)
    .setDisabled(disabled)
}

function buildComponents(token: string, state: SlotsState): SlotsComponent[] {
  const container = new ContainerBuilder()
    .setAccentColor(SLOTS_COLOR)
    .addTextDisplayComponents(new TextDisplayBuilder().setContent(`# Slot machine\n${outcomeLines(state).join('\n')}`))
    .addSeparatorComponents(new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small).setDivider(true))
    .addTextDisplayComponents(new TextDisplayBuilder().setContent(`-# \`${state.commandInput}\``))

  return withPubtabButton(
    [container, new ActionRowBuilder<ButtonBuilder>().addComponents(buildSpinButton(token, false))],
    state.pubtab
  )
}

function buildExpiredComponents(): SlotsComponent[] {
  return [
    new ContainerBuilder()
      .setAccentColor(SLOTS_COLOR)
      .addTextDisplayComponents(new TextDisplayBuilder().setContent('# Slot machine\nGame expired.'))
  ]
}

export function isSlotsSpinButtonId(customId: string): boolean {
  return customId.startsWith(`${SLOTS_SPIN_BUTTON_ID}:`)
}

export async function handleSlotsSpinButton(interaction: ButtonInteraction): Promise<void> {
  const token = parseSpinId(interaction.customId)
  if (!token) {
    await interaction.reply({
      components: buildExpiredComponents() as never,
      flags: [MessageFlags.IsComponentsV2, MessageFlags.Ephemeral]
    })
    return
  }

  const state = loadState(token)
  if (!state) {
    await interaction.reply({
      components: buildExpiredComponents() as never,
      flags: [MessageFlags.IsComponentsV2, MessageFlags.Ephemeral]
    })
    return
  }

  state.lastSpin = spinResult()
  state.pulls = (state.pulls ?? 0) + 1
  state.lastPlayer = displayName(interaction)

  storeState(token, state)

  await interaction.update({
    components: buildComponents(token, state) as never,
    flags: MessageFlags.IsComponentsV2
  })
}

export const subcommand: Subcommand = {
  name: 'slots',
  description: 'slot machine',
  usage: 'slots [--pub]',
  examples: ['slots', 'slots --pub'],
  pubtab: { label: 'Slots', args: '' },

  async autocomplete(restArgs, flags) {
    if (!restArgs.includes(' ')) {
      void flags
      return [{ name: 'Slots', value: 'slots' }]
    }

    return []
  },

  async execute(interaction, args, flags) {
    const token = randomUUID().replace(/-/g, '').slice(0, 16)
    const state: SlotsState = {
      commandInput: args,
      pub: flags.has('pub'),
      pubtab: isPubtabContext(flags),
      pulls: 0,
      lastPlayer: interaction.user.globalName ?? interaction.user.username
    }

    storeState(token, state)

    const components = buildComponents(token, state)
    if (interaction.deferred) {
      await interaction.editReply({
        components: components as never,
        flags: MessageFlags.IsComponentsV2
      })
      return
    }

    await interaction.reply({
      components: components as never,
      flags: state.pub
        ? ([MessageFlags.IsComponentsV2] as const)
        : ([MessageFlags.IsComponentsV2, MessageFlags.Ephemeral] as const)
    })
  }
}
