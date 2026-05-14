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
import type { CommandInteraction, Subcommand } from '../types.js'
import type { Flags } from '../flags.js'
import { getStoredValue, setStoredValue } from '../helpers/kv-store.js'

export const RPS_PICK_BUTTON_ID = 'rps-pick'
export const RPS_PUBLISH_BUTTON_ID = 'rps-publish'

const RPS_COLOR = 0x5865f2
const RPS_STATE_KEY = 'rps'
const CHOICES = ['rock', 'paper', 'scissors'] as const
const BEATS: Record<Choice, Choice> = {
  rock: 'scissors',
  paper: 'rock',
  scissors: 'paper'
}

type Choice = (typeof CHOICES)[number]
type RpsMode = 'pc' | 'duel'

interface RpsPick {
  userId: string
  name: string
  choice: Choice
}

interface PcResult {
  player: string
  playerChoice: Choice
  pcChoice: Choice
}

interface RpsState {
  mode: RpsMode
  commandInput: string
  pub: boolean
  picks: RpsPick[]
  lastPc?: PcResult
}

type RpsComponent = ContainerBuilder | ActionRowBuilder<ButtonBuilder>

function stateKey(token: string): string {
  return `${RPS_STATE_KEY}:${token}`
}

function storeState(token: string, state: RpsState): void {
  setStoredValue(stateKey(token), JSON.stringify(state))
}

function loadState(token: string): RpsState | null {
  const stored = getStoredValue(stateKey(token))
  if (!stored) return null

  try {
    const state = JSON.parse(stored) as RpsState
    if ((state.mode !== 'pc' && state.mode !== 'duel') || !Array.isArray(state.picks)) {
      return null
    }
    return {
      ...state,
      commandInput: typeof state.commandInput === 'string' ? state.commandInput : 'rps',
      pub: Boolean(state.pub)
    }
  } catch {
    return null
  }
}

function isChoice(value: string | undefined): value is Choice {
  return CHOICES.includes(value as Choice)
}

function formatChoice(choice: Choice): string {
  return choice[0].toUpperCase() + choice.slice(1)
}

function randomChoice(): Choice {
  return CHOICES[Math.floor(Math.random() * CHOICES.length)] ?? 'rock'
}

function outcome(left: Choice, right: Choice): 'draw' | 'left' | 'right' {
  if (left === right) return 'draw'
  return BEATS[left] === right ? 'left' : 'right'
}

function parsePickId(customId: string): { token: string; choice: Choice } | null {
  const [base, token, choice] = customId.split(':')
  if (base !== RPS_PICK_BUTTON_ID || !token || !isChoice(choice)) return null
  return { token, choice }
}

function parsePublishId(customId: string): string | null {
  const prefix = `${RPS_PUBLISH_BUTTON_ID}:`
  return customId.startsWith(prefix) ? customId.slice(prefix.length) : null
}

function displayName(interaction: ButtonInteraction): string {
  return interaction.user.globalName ?? interaction.user.username
}

function pcLines(state: RpsState): string[] {
  if (!state.lastPc) {
    return ['Pick a throw. The PC throws at the same time.']
  }

  const result = outcome(state.lastPc.playerChoice, state.lastPc.pcChoice)
  const winner =
    result === 'draw' ? 'Draw.' : result === 'left' ? `${state.lastPc.player} wins.` : 'PC wins.'

  return [
    `${state.lastPc.player}: ${formatChoice(state.lastPc.playerChoice)}`,
    `PC: ${formatChoice(state.lastPc.pcChoice)}`,
    winner,
    'Pick again for another round.'
  ]
}

function duelLines(state: RpsState): string[] {
  if (state.picks.length === 0) {
    return ['Two users choose a throw.', 'Choices reveal after the second player locks in.']
  }

  if (state.picks.length === 1) {
    return [`${state.picks[0].name} locked in a choice.`, 'Waiting for one more player.']
  }

  const [left, right] = state.picks
  const result = outcome(left.choice, right.choice)
  const winner = result === 'draw' ? 'Draw.' : `${result === 'left' ? left.name : right.name} wins.`

  return [
    `${left.name}: ${formatChoice(left.choice)}`,
    `${right.name}: ${formatChoice(right.choice)}`,
    winner
  ]
}

function pickButton(token: string, choice: Choice, disabled: boolean): ButtonBuilder {
  const style =
    choice === 'rock' ? ButtonStyle.Secondary : choice === 'paper' ? ButtonStyle.Primary : ButtonStyle.Danger

  return new ButtonBuilder()
    .setCustomId(`${RPS_PICK_BUTTON_ID}:${token}:${choice}`)
    .setLabel(formatChoice(choice))
    .setStyle(style)
    .setDisabled(disabled)
}

function buildPickRow(token: string, state: RpsState): ActionRowBuilder<ButtonBuilder> {
  const disabled = state.mode === 'duel' && state.picks.length >= 2
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    CHOICES.map((choice) => pickButton(token, choice, disabled))
  )
}

function buildPublishRow(token: string): ActionRowBuilder<ButtonBuilder> {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`${RPS_PUBLISH_BUTTON_ID}:${token}`)
      .setLabel('Publish duel')
      .setStyle(ButtonStyle.Success)
  )
}

function buildComponents(
  token: string,
  state: RpsState,
  commandInput: string,
  includePublish: boolean
): RpsComponent[] {
  const title = state.mode === 'pc' ? 'Rock paper scissors' : 'Rock paper scissors duel'
  const lines = state.mode === 'pc' ? pcLines(state) : duelLines(state)
  const container = new ContainerBuilder()
    .setAccentColor(RPS_COLOR)
    .addTextDisplayComponents(new TextDisplayBuilder().setContent(`## ${title}\n${lines.join('\n')}`))
    .addSeparatorComponents(
      new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small).setDivider(true)
    )
    .addTextDisplayComponents(new TextDisplayBuilder().setContent(`-# \`${commandInput}\``))

  const components: RpsComponent[] = [container, buildPickRow(token, state)]
  if (includePublish) components.push(buildPublishRow(token))
  return components
}

function buildExpiredComponents(): RpsComponent[] {
  return [
    new ContainerBuilder()
      .setAccentColor(RPS_COLOR)
      .addTextDisplayComponents(new TextDisplayBuilder().setContent('## Rock paper scissors\nGame expired.'))
  ]
}

async function sendInitialGame(
  interaction: CommandInteraction,
  token: string,
  state: RpsState,
  commandInput: string,
  pub: boolean
): Promise<void> {
  const components = buildComponents(token, state, commandInput, !pub)
  if (interaction.deferred) {
    await interaction.editReply({ components: components as never, flags: MessageFlags.IsComponentsV2 })
    return
  }

  await interaction.reply({
    components: components as never,
    flags: pub
      ? ([MessageFlags.IsComponentsV2] as const)
      : ([MessageFlags.IsComponentsV2, MessageFlags.Ephemeral] as const)
  })
}

function initialMode(restArgs: string, flags: Flags): RpsMode {
  const mode = restArgs.trim().toLowerCase()
  if (mode === 'duel') return 'duel'
  if (mode === 'pc' || flags.has('pc')) return 'pc'
  return flags.has('pub') ? 'duel' : 'pc'
}

export function isRpsButtonId(customId: string): boolean {
  return customId.startsWith(`${RPS_PICK_BUTTON_ID}:`) || customId.startsWith(`${RPS_PUBLISH_BUTTON_ID}:`)
}

export async function handleRpsButton(interaction: ButtonInteraction): Promise<void> {
  const publishToken = parsePublishId(interaction.customId)
  if (publishToken) {
    const token = randomUUID().replace(/-/g, '').slice(0, 16)
    const state: RpsState = { mode: 'duel', commandInput: 'rps --pub', pub: true, picks: [] }
    storeState(token, state)
    await interaction.reply({
      components: buildComponents(token, state, state.commandInput, false) as never,
      flags: [MessageFlags.IsComponentsV2]
    })
    return
  }

  const parsed = parsePickId(interaction.customId)
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

  if (state.mode === 'pc') {
    state.lastPc = {
      player: displayName(interaction),
      playerChoice: parsed.choice,
      pcChoice: randomChoice()
    }
  } else if (state.picks.length < 2 || state.picks.some((pick) => pick.userId === interaction.user.id)) {
    const existing = state.picks.find((pick) => pick.userId === interaction.user.id)
    if (existing) {
      existing.name = displayName(interaction)
      existing.choice = parsed.choice
    } else {
      state.picks.push({ userId: interaction.user.id, name: displayName(interaction), choice: parsed.choice })
    }
  }

  storeState(parsed.token, state)
  await interaction.update({
    components: buildComponents(parsed.token, state, state.commandInput, !state.pub) as never,
    flags: MessageFlags.IsComponentsV2
  })
}

export const subcommand: Subcommand = {
  name: 'rps',
  description: 'rock paper scissors',
  usage: 'rps [pc|duel] [--pub] [--pc]',
  examples: ['rps', 'rps --pub', 'rps pc --pub'],

  flags: {
    pc: { description: 'play the PC even in a public reply' }
  },

  async execute(interaction, args, flags) {
    const restArgs = args.replace(/^\S+\s*/, '').trim()
    const pub = flags.has('pub')
    const mode = initialMode(restArgs, flags)
    const token = randomUUID().replace(/-/g, '').slice(0, 16)
    const state: RpsState = { mode, commandInput: args, pub, picks: [] }

    storeState(token, state)
    await sendInitialGame(interaction, token, state, args, pub)
  }
}
