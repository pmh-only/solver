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

export const BLACKJACK_BUTTON_ID = 'blackjack-action'

const BLACKJACK_COLOR = 0x111827
const BLACKJACK_STATE_KEY = 'blackjack'
const RANKS = ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'] as const
const SUITS = ['♠', '♥', '♦', '♣'] as const

type BlackjackAction = 'hit' | 'stand'

interface Card {
  rank: string
  suit: string
}

interface BlackjackState {
  commandInput: string
  pub: boolean
  pubtab: boolean
  player: Card[]
  dealer: Card[]
  chooser: string
  stood?: boolean
  result?: string
}

type BlackjackComponent = ContainerBuilder | ActionRowBuilder<ButtonBuilder>

function stateKey(token: string): string {
  return `${BLACKJACK_STATE_KEY}:${token}`
}

function storeState(token: string, state: BlackjackState): void {
  setStoredValue(stateKey(token), JSON.stringify(state))
}

function isCard(value: unknown): value is Card {
  if (!value || typeof value !== 'object') return false
  const card = value as Partial<Card>
  return typeof card.rank === 'string' && typeof card.suit === 'string'
}

function loadState(token: string): BlackjackState | null {
  const stored = getStoredValue(stateKey(token))
  if (!stored) return null

  try {
    const parsed = JSON.parse(stored) as Partial<BlackjackState>
    if (typeof parsed.commandInput !== 'string') return null
    if (typeof parsed.chooser !== 'string' || !parsed.chooser) return null
    if (!Array.isArray(parsed.player) || !Array.isArray(parsed.dealer)) return null

    return {
      commandInput: parsed.commandInput,
      pub: Boolean(parsed.pub),
      pubtab: Boolean(parsed.pubtab),
      player: parsed.player.filter(isCard),
      dealer: parsed.dealer.filter(isCard),
      chooser: parsed.chooser,
      stood: Boolean(parsed.stood),
      result: typeof parsed.result === 'string' ? parsed.result : undefined
    }
  } catch {
    return null
  }
}

function displayName(interaction: ButtonInteraction): string {
  return interaction.user.globalName ?? interaction.user.username
}

function drawCard(): Card {
  return {
    rank: RANKS[Math.floor(Math.random() * RANKS.length)] ?? 'A',
    suit: SUITS[Math.floor(Math.random() * SUITS.length)] ?? '♠'
  }
}

function handValue(cards: Card[]): number {
  let total = 0
  let aces = 0

  for (const card of cards) {
    if (card.rank === 'A') {
      total += 11
      aces++
    } else if (card.rank === 'J' || card.rank === 'Q' || card.rank === 'K') {
      total += 10
    } else {
      total += Number.parseInt(card.rank, 10)
    }
  }

  while (total > 21 && aces > 0) {
    total -= 10
    aces--
  }

  return total
}

function cardText(cards: Card[], hideSecond = false): string {
  return cards.map((card, index) => (hideSecond && index === 1 ? '??' : `${card.rank}${card.suit}`)).join(' ')
}

function settle(state: BlackjackState): void {
  while (handValue(state.dealer) < 17) {
    state.dealer.push(drawCard())
  }

  const player = handValue(state.player)
  const dealer = handValue(state.dealer)
  state.stood = true

  if (player > 21) state.result = 'Bust. Dealer wins.'
  else if (dealer > 21) state.result = 'Dealer busts. You win.'
  else if (player > dealer) state.result = 'You win.'
  else if (player < dealer) state.result = 'Dealer wins.'
  else state.result = 'Push.'
}

function parseActionId(customId: string): { token: string; action: BlackjackAction } | null {
  const [base, token, action] = customId.split(':')
  if (base !== BLACKJACK_BUTTON_ID || !token) return null
  if (action !== 'hit' && action !== 'stand') return null
  return { token, action }
}

function resultLines(state: BlackjackState): string[] {
  const over = Boolean(state.result)
  const dealerShown = over ? cardText(state.dealer) : cardText(state.dealer, true)
  const dealerValue = over ? ` (${handValue(state.dealer)})` : ''

  return [
    `${state.chooser}'s hand: ${cardText(state.player)} (${handValue(state.player)})`,
    `Dealer: ${dealerShown}${dealerValue}`,
    state.result ?? 'Hit for another card or stand to let the dealer play.'
  ]
}

function actionButton(token: string, action: BlackjackAction, disabled: boolean): ButtonBuilder {
  return new ButtonBuilder()
    .setCustomId(`${BLACKJACK_BUTTON_ID}:${token}:${action}`)
    .setLabel(action === 'hit' ? 'Hit' : 'Stand')
    .setStyle(action === 'hit' ? ButtonStyle.Primary : ButtonStyle.Secondary)
    .setDisabled(disabled)
}

function buildComponents(token: string, state: BlackjackState): BlackjackComponent[] {
  const over = Boolean(state.result)
  const container = new ContainerBuilder()
    .setAccentColor(BLACKJACK_COLOR)
    .addTextDisplayComponents(new TextDisplayBuilder().setContent(`## Blackjack\n${resultLines(state).join('\n')}`))
    .addSeparatorComponents(new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small).setDivider(true))
    .addTextDisplayComponents(new TextDisplayBuilder().setContent(`-# \`${state.commandInput}\``))

  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    actionButton(token, 'hit', over),
    actionButton(token, 'stand', over)
  )

  return withPubtabButton([container, row], state.pubtab)
}

function buildExpiredComponents(): BlackjackComponent[] {
  return [
    new ContainerBuilder()
      .setAccentColor(BLACKJACK_COLOR)
      .addTextDisplayComponents(new TextDisplayBuilder().setContent('## Blackjack\nGame expired.'))
  ]
}

export function isBlackjackButtonId(customId: string): boolean {
  return customId.startsWith(`${BLACKJACK_BUTTON_ID}:`)
}

export async function handleBlackjackButton(interaction: ButtonInteraction): Promise<void> {
  const parsed = parseActionId(interaction.customId)
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

  if (!state.result) {
    state.chooser = displayName(interaction)
    if (parsed.action === 'hit') {
      state.player.push(drawCard())
      if (handValue(state.player) > 21) settle(state)
    } else {
      settle(state)
    }
  }

  storeState(parsed.token, state)
  await interaction.update({
    components: buildComponents(parsed.token, state) as never,
    flags: MessageFlags.IsComponentsV2
  })
}

export const subcommand: Subcommand = {
  name: 'blackjack',
  description: 'blackjack hand',
  usage: 'blackjack [--pub]',
  examples: ['blackjack', 'blackjack --pub'],
  pubtab: { label: 'Blackjack', args: '' },

  async execute(interaction, args, flags) {
    const token = randomUUID().replace(/-/g, '').slice(0, 16)
    const state: BlackjackState = {
      commandInput: args,
      pub: flags.has('pub'),
      pubtab: isPubtabContext(flags),
      player: [drawCard(), drawCard()],
      dealer: [drawCard(), drawCard()],
      chooser: interaction.user.globalName ?? interaction.user.username
    }

    if (handValue(state.player) === 21) settle(state)
    storeState(token, state)

    const components = buildComponents(token, state)
    if (interaction.deferred) {
      await interaction.editReply({ components: components as never, flags: MessageFlags.IsComponentsV2 })
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
