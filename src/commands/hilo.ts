import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  MessageFlags,
  type ButtonInteraction
} from 'discord.js'
import { randomUUID } from 'node:crypto'
import type { Subcommand } from '../types.js'
import { getStoredValue, setStoredValue } from '../helpers/kv-store.js'
import { isPubtabContext } from '../flags.js'
import { withPubtabButton } from '../components.js'
import { createGamePresentation, type GamePresentation } from '../canvas-presentation.js'

export const HILO_GUESS_BUTTON_ID = 'hilo-guess'

const HILO_COLOR = 0x06b6d4
const HILO_STATE_KEY = 'hilo'
const HILO_MIN = 1
const HILO_MAX = 100

type HiloDirection = 'higher' | 'lower'

type HiloResult = HiloDirection | 'same'

interface HiloState {
  commandInput: string
  pub: boolean
  pubtab: boolean
  current: number
  chooser: string
  lastGuess?: HiloDirection
  previous?: number
  next?: number
  result?: HiloResult
}

function stateKey(token: string): string {
  return `${HILO_STATE_KEY}:${token}`
}

function storeState(token: string, state: HiloState): void {
  setStoredValue(stateKey(token), JSON.stringify(state))
}

function loadState(token: string): HiloState | null {
  const stored = getStoredValue(stateKey(token))
  if (!stored) return null

  try {
    const parsed = JSON.parse(stored) as Partial<HiloState>
    if (!isDirection(parsed.result)) {
      parsed.result = undefined
    }

    if (typeof parsed.commandInput !== 'string' || parsed.commandInput.length === 0) return null
    if (typeof parsed.chooser !== 'string' || !parsed.chooser) return null
    if (!isSafeNumber(parsed.current)) return null

    return {
      commandInput: parsed.commandInput,
      pub: Boolean(parsed.pub),
      pubtab: Boolean(parsed.pubtab),
      current: parsed.current,
      chooser: parsed.chooser,
      lastGuess: isDirection(parsed.lastGuess) ? parsed.lastGuess : undefined,
      previous: isSafeNumber(parsed.previous) ? parsed.previous : undefined,
      next: isSafeNumber(parsed.next) ? parsed.next : undefined,
      result: isDirection(parsed.result)
        ? parsed.result
        : parsed.result === 'same'
          ? parsed.result
          : undefined
    }
  } catch {
    return null
  }
}

function isDirection(value: unknown): value is HiloDirection {
  return value === 'higher' || value === 'lower'
}

function isSafeNumber(value: unknown): value is number {
  return (
    typeof value === 'number' && Number.isInteger(value) && value >= HILO_MIN && value <= HILO_MAX
  )
}

function parseGuessId(customId: string): { token: string; guess: HiloDirection } | null {
  const [base, token, guessRaw] = customId.split(':')
  const guess = guessRaw === 'higher' || guessRaw === 'lower' ? (guessRaw as HiloDirection) : null
  if (base !== HILO_GUESS_BUTTON_ID || !token || !guess) return null
  return { token, guess }
}

function randomNumber(): number {
  return Math.floor(Math.random() * (HILO_MAX - HILO_MIN + 1)) + HILO_MIN
}

function outcome(previous: number, next: number): HiloResult {
  if (next > previous) return 'higher'
  if (next < previous) return 'lower'
  return 'same'
}

function directionLabel(direction: HiloDirection): string {
  return direction === 'higher' ? 'Higher' : 'Lower'
}

function resultLines(state: HiloState): string[] {
  if (!state.lastGuess || !state.next || !state.result) {
    return [
      `Current number: **${state.current}**`,
      'Guess whether the next number is higher or lower than this one.'
    ]
  }

  const outcomeLabel =
    state.result === 'same'
      ? 'It landed exactly the same. No one wins this round.'
      : state.result === state.lastGuess
        ? 'You win.'
        : 'You lose.'

  return [
    `${state.chooser} guessed ${directionLabel(state.lastGuess)}.`,
    `The next number was **${state.next}**.`,
    outcomeLabel
  ]
}

function buildGuessButton(
  token: string,
  direction: HiloDirection,
  disabled: boolean
): ButtonBuilder {
  return new ButtonBuilder()
    .setCustomId(`${HILO_GUESS_BUTTON_ID}:${token}:${direction}`)
    .setLabel(direction === 'higher' ? 'Higher' : 'Lower')
    .setStyle(direction === 'higher' ? ButtonStyle.Success : ButtonStyle.Primary)
    .setDisabled(disabled)
}

function buildComponents(token: string, state: HiloState): GamePresentation {
  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    buildGuessButton(token, 'lower', Boolean(state.result)),
    buildGuessButton(token, 'higher', Boolean(state.result))
  )
  const presentation = createGamePresentation({
    id: `hilo-${token}`,
    title: 'High-Low',
    kicker: state.result ? 'Prediction complete' : 'Predict the next number',
    lines: resultLines(state),
    accent: HILO_COLOR,
    footer: state.commandInput,
    visual: { kind: 'hilo', current: state.current, previous: state.previous },
    controls: [row]
  })
  presentation.components = withPubtabButton(presentation.components, state.pubtab)
  return presentation
}

function buildExpiredComponents(): GamePresentation {
  return createGamePresentation({
    id: 'hilo-expired',
    title: 'High-Low',
    kicker: 'Game unavailable',
    lines: ['Game expired. Start a new prediction with `hilo`.'],
    accent: HILO_COLOR,
    visual: { kind: 'hilo', current: 50 }
  })
}

export function isHiloButtonId(customId: string): boolean {
  return customId.startsWith(`${HILO_GUESS_BUTTON_ID}:`)
}

export async function handleHiloGuessButton(interaction: ButtonInteraction): Promise<void> {
  const parsed = parseGuessId(interaction.customId)
  if (!parsed) {
    const expired = buildExpiredComponents()
    await interaction.reply({
      components: expired.components as never,
      files: expired.files,
      flags: [MessageFlags.IsComponentsV2, MessageFlags.Ephemeral]
    })
    return
  }

  const state = loadState(parsed.token)
  if (!state) {
    const expired = buildExpiredComponents()
    await interaction.reply({
      components: expired.components as never,
      files: expired.files,
      flags: [MessageFlags.IsComponentsV2, MessageFlags.Ephemeral]
    })
    return
  }

  const next = randomNumber()
  state.previous = state.current
  state.lastGuess = parsed.guess
  state.next = next
  state.result = outcome(state.current, next)
  state.current = next
  state.chooser = interaction.user.globalName ?? interaction.user.username

  storeState(parsed.token, state)

  const presentation = buildComponents(parsed.token, state)
  await interaction.update({
    components: presentation.components as never,
    files: presentation.files,
    attachments: [],
    flags: MessageFlags.IsComponentsV2
  })
}

export const subcommand: Subcommand = {
  name: 'hilo',
  description: 'high-low prediction',
  usage: 'hilo [--pub]',
  examples: ['hilo', 'hilo --pub'],
  pubtab: { label: 'High-Low', args: '' },

  async autocomplete(restArgs, flags) {
    if (!restArgs.includes(' ')) {
      void flags
      return [{ name: 'High-Low', value: 'hilo' }]
    }
    return []
  },

  async execute(interaction, args, flags) {
    const token = randomUUID().replace(/-/g, '').slice(0, 16)
    const state: HiloState = {
      commandInput: args,
      pub: flags.has('pub'),
      pubtab: isPubtabContext(flags),
      chooser: interaction.user.globalName ?? interaction.user.username,
      current: randomNumber()
    }

    storeState(token, state)
    const presentation = buildComponents(token, state)

    if (interaction.deferred) {
      await interaction.editReply({
        components: presentation.components as never,
        files: presentation.files,
        attachments: [],
        flags: MessageFlags.IsComponentsV2
      })
      return
    }

    await interaction.reply({
      components: presentation.components as never,
      files: presentation.files,
      flags: state.pub
        ? ([MessageFlags.IsComponentsV2] as const)
        : ([MessageFlags.IsComponentsV2, MessageFlags.Ephemeral] as const)
    })
  }
}
