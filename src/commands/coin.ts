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

export const COIN_GUESS_BUTTON_ID = 'coin-guess'

const COIN_STATE_KEY = 'coin'
const COIN_COLOR = 0xf59e0b
const HEADS = 'heads'
const TAILS = 'tails'

type CoinSide = typeof HEADS | typeof TAILS

interface CoinState {
  commandInput: string
  pub: boolean
  lastGuess?: CoinSide
  result?: CoinSide
  chooser: string
}

type CoinComponent = ContainerBuilder | ActionRowBuilder<ButtonBuilder>

function stateKey(token: string): string {
  return `${COIN_STATE_KEY}:${token}`
}

function storeState(token: string, state: CoinState): void {
  setStoredValue(stateKey(token), JSON.stringify(state))
}

function loadState(token: string): CoinState | null {
  const stored = getStoredValue(stateKey(token))
  if (!stored) return null

  try {
    const parsed = JSON.parse(stored) as Partial<CoinState>
    if (typeof parsed.chooser !== 'string') return null
    if (typeof parsed.commandInput !== 'string') return null
    if (parsed.chooser.length === 0) return null

    return {
      commandInput: parsed.commandInput,
      pub: Boolean(parsed.pub),
      lastGuess: isSide(parsed.lastGuess as CoinSide | undefined) ? parsed.lastGuess : undefined,
      result: isSide(parsed.result as CoinSide | undefined) ? parsed.result : undefined,
      chooser: parsed.chooser
    }
  } catch {
    return null
  }
}

function isSide(value: string | undefined): value is CoinSide {
  return value === HEADS || value === TAILS
}

function parseGuessId(customId: string): { token: string; guess: CoinSide } | null {
  const [base, token, guess] = customId.split(':')
  if (base !== COIN_GUESS_BUTTON_ID || !token || !isSide(guess)) return null
  return { token, guess }
}

function randomSide(): CoinSide {
  return Math.random() < 0.5 ? HEADS : TAILS
}

function capitalize(value: CoinSide): string {
  return value[0].toUpperCase() + value.slice(1)
}

function resultLines(state: CoinState): string[] {
  if (!state.result || !state.lastGuess) {
    return ['Pick a side to call the coin toss.', 'The result appears instantly.']
  }

  const winner = state.result === state.lastGuess ? 'win' : 'lose'
  return [
    `${capitalize(state.lastGuess)} called by ${state.chooser}.`,
    `Coin landed on ${capitalize(state.result)}.`,
    winner === 'win' ? 'You win.' : 'You lose.'
  ]
}

function buildGuessButton(token: string, side: CoinSide, disabled: boolean): ButtonBuilder {
  return new ButtonBuilder()
    .setCustomId(`${COIN_GUESS_BUTTON_ID}:${token}:${side}`)
    .setLabel(capitalize(side))
    .setStyle(side === HEADS ? ButtonStyle.Secondary : ButtonStyle.Primary)
    .setDisabled(disabled)
}

function buildComponents(token: string, state: CoinState): CoinComponent[] {
  const container = new ContainerBuilder()
    .setAccentColor(COIN_COLOR)
    .addTextDisplayComponents(new TextDisplayBuilder().setContent(`## Coin flip\n${resultLines(state).join('\n')}`))
    .addSeparatorComponents(new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small).setDivider(true))
    .addTextDisplayComponents(new TextDisplayBuilder().setContent(`-# \`${state.commandInput}\``))

  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    buildGuessButton(token, HEADS, Boolean(state.result)),
    buildGuessButton(token, TAILS, Boolean(state.result))
  )

  return [container, row]
}

function buildExpiredComponents(): CoinComponent[] {
  return [
    new ContainerBuilder()
      .setAccentColor(COIN_COLOR)
      .addTextDisplayComponents(new TextDisplayBuilder().setContent('## Coin flip\nGame expired.'))
  ]
}

function displayName(interaction: ButtonInteraction): string {
  return interaction.user.globalName ?? interaction.user.username
}

export function isCoinButtonId(customId: string): boolean {
  return customId.startsWith(`${COIN_GUESS_BUTTON_ID}:`)
}

export async function handleCoinButton(interaction: ButtonInteraction): Promise<void> {
  const parsed = parseGuessId(interaction.customId)
  if (!parsed) {
    await interaction.reply({
      components: buildExpiredComponents() as never,
      flags: [MessageFlags.IsComponentsV2, MessageFlags.Ephemeral]
    })
    return
  }

  const state = loadState(parsed.token)
  if (!state) {
    await interaction.reply({
      components: buildExpiredComponents() as never,
      flags: [MessageFlags.IsComponentsV2, MessageFlags.Ephemeral]
    })
    return
  }

  state.lastGuess = parsed.guess
  state.result = randomSide()
  state.chooser = displayName(interaction)

  storeState(parsed.token, state)

  await interaction.update({
    components: buildComponents(parsed.token, state) as never,
    flags: MessageFlags.IsComponentsV2
  })
}

export const subcommand: Subcommand = {
  name: 'coin',
  description: 'coin flip',
  usage: 'coin [--pub]',
  examples: ['coin', 'coin --pub'],
  async execute(interaction, args, flags) {
    const token = randomUUID().replace(/-/g, '').slice(0, 16)
    const state: CoinState = {
      commandInput: args,
      pub: flags.has('pub'),
      chooser: interaction.user.globalName ?? interaction.user.username
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
