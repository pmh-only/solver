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

export const DICE_GUESS_BUTTON_ID = 'dice-guess'

const DICE_STATE_KEY = 'dice'

type DiceValue = 1 | 2 | 3 | 4 | 5 | 6

interface DiceState {
  commandInput: string
  pub: boolean
  pubtab: boolean
  lastGuess?: DiceValue
  result?: DiceValue
  chooser: string
}

function stateKey(token: string): string {
  return `${DICE_STATE_KEY}:${token}`
}

function storeState(token: string, state: DiceState): void {
  setStoredValue(stateKey(token), JSON.stringify(state))
}

function isDiceValue(value: number | undefined): value is DiceValue {
  return value === 1 || value === 2 || value === 3 || value === 4 || value === 5 || value === 6
}

function loadState(token: string): DiceState | null {
  const stored = getStoredValue(stateKey(token))
  if (!stored) return null

  try {
    const parsed = JSON.parse(stored) as Partial<DiceState>
    if (typeof parsed.chooser !== 'string' || !parsed.chooser) return null
    if (typeof parsed.commandInput !== 'string') return null

    return {
      commandInput: parsed.commandInput,
      pub: Boolean(parsed.pub),
      pubtab: Boolean(parsed.pubtab),
      chooser: parsed.chooser,
      lastGuess: isDiceValue(parsed.lastGuess) ? parsed.lastGuess : undefined,
      result: isDiceValue(parsed.result) ? parsed.result : undefined
    }
  } catch {
    return null
  }
}

function randomRoll(): DiceValue {
  return (Math.floor(Math.random() * 6) + 1) as DiceValue
}

function parseRollId(customId: string): { token: string; guess: DiceValue } | null {
  const [base, token, guessRaw] = customId.split(':')
  const guess = Number.parseInt(guessRaw ?? '', 10)
  if (base !== DICE_GUESS_BUTTON_ID || !token || !isDiceValue(guess)) return null
  return { token, guess }
}

function displayName(interaction: ButtonInteraction): string {
  return interaction.user.globalName ?? interaction.user.username
}

function buildGuessButton(token: string, value: DiceValue, disabled: boolean): ButtonBuilder {
  return new ButtonBuilder()
    .setCustomId(`${DICE_GUESS_BUTTON_ID}:${token}:${value}`)
    .setLabel(`${value}`)
    .setStyle(ButtonStyle.Primary)
    .setDisabled(disabled)
}

function resultLines(state: DiceState): string[] {
  if (!state.result || !state.lastGuess) {
    return ['Pick a number from 1 through 6 and roll the die.']
  }

  return [
    `${state.chooser} guessed ${state.lastGuess}.`,
    `The die rolled ${state.result}.`,
    state.result === state.lastGuess ? 'You win.' : 'You lose.'
  ]
}

function buildComponents(token: string, state: DiceState): GamePresentation {
  const rowOne = new ActionRowBuilder<ButtonBuilder>().addComponents(
    buildGuessButton(token, 1, Boolean(state.result)),
    buildGuessButton(token, 2, Boolean(state.result)),
    buildGuessButton(token, 3, Boolean(state.result))
  )

  const rowTwo = new ActionRowBuilder<ButtonBuilder>().addComponents(
    buildGuessButton(token, 4, Boolean(state.result)),
    buildGuessButton(token, 5, Boolean(state.result)),
    buildGuessButton(token, 6, Boolean(state.result))
  )

  const presentation = createGamePresentation({
    id: `dice-${token}`,
    title: 'Dice roll',
    kicker: state.result ? 'Roll complete' : 'Choose your number',
    lines: resultLines(state),
    footer: state.commandInput,
    visual: { kind: 'dice', value: state.result },
    controls: [rowOne, rowTwo]
  })
  presentation.components = withPubtabButton(presentation.components, state.pubtab)
  return presentation
}

function buildExpiredComponents(): GamePresentation {
  return createGamePresentation({
    id: 'dice-expired',
    title: 'Dice roll',
    kicker: 'Game unavailable',
    lines: ['Game expired. Start a new roll with `dice`.'],
    visual: { kind: 'dice' }
  })
}

export function isDiceButtonId(customId: string): boolean {
  return customId.startsWith(`${DICE_GUESS_BUTTON_ID}:`)
}

export async function handleDiceButton(interaction: ButtonInteraction): Promise<void> {
  const parsed = parseRollId(interaction.customId)
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

  state.lastGuess = parsed.guess
  state.result = randomRoll()
  state.chooser = displayName(interaction)

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
  name: 'dice',
  description: 'dice roll',
  usage: 'dice [--pub]',
  examples: ['dice', 'dice --pub'],
  pubtab: { label: 'Dice', args: '' },

  async autocomplete(restArgs, flags) {
    if (!restArgs.includes(' ')) {
      void flags
      return [{ name: 'Dice', value: 'dice' }]
    }
    return []
  },

  async execute(interaction, args, flags) {
    const token = randomUUID().replace(/-/g, '').slice(0, 16)
    const state: DiceState = {
      commandInput: args,
      pub: flags.has('pub'),
      pubtab: isPubtabContext(flags),
      chooser: interaction.user.globalName ?? interaction.user.username
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
