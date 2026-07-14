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

export const MEMORY_TILE_BUTTON_ID = 'memory-tile'

const MEMORY_COLOR = 0x7c3aed
const MEMORY_STATE_KEY = 'memory'
const MEMORY_SYMBOLS = ['🍎', '🍇', '🍊', '🍓', '🥝', '🍍', '🥥', '🍑'] as const
const MEMORY_SIZE = 16
const MEMORY_WIDTH = 4

interface MemoryState {
  commandInput: string
  pub: boolean
  pubtab: boolean
  tiles: string[]
  matched: number[]
  selected: number[]
  moves: number
  chooser: string
  lastResult?: string
}

type MemoryComponent = ContainerBuilder | ActionRowBuilder<ButtonBuilder>

function stateKey(token: string): string {
  return `${MEMORY_STATE_KEY}:${token}`
}

function storeState(token: string, state: MemoryState): void {
  setStoredValue(stateKey(token), JSON.stringify(state))
}

function loadState(token: string): MemoryState | null {
  const stored = getStoredValue(stateKey(token))
  if (!stored) return null

  try {
    const parsed = JSON.parse(stored) as Partial<MemoryState>
    if (typeof parsed.commandInput !== 'string') return null
    if (typeof parsed.chooser !== 'string' || !parsed.chooser) return null
    if (!Array.isArray(parsed.tiles) || parsed.tiles.length !== MEMORY_SIZE) return null

    return {
      commandInput: parsed.commandInput,
      pub: Boolean(parsed.pub),
      pubtab: Boolean(parsed.pubtab),
      tiles: parsed.tiles.map((tile) => (typeof tile === 'string' ? tile : '?')),
      matched: Array.isArray(parsed.matched) ? parsed.matched.filter(isTileIndex) : [],
      selected: Array.isArray(parsed.selected) ? parsed.selected.filter(isTileIndex).slice(0, 2) : [],
      moves: typeof parsed.moves === 'number' && Number.isInteger(parsed.moves) ? parsed.moves : 0,
      chooser: parsed.chooser,
      lastResult: typeof parsed.lastResult === 'string' ? parsed.lastResult : undefined
    }
  } catch {
    return null
  }
}

function isTileIndex(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value < MEMORY_SIZE
}

function displayName(interaction: ButtonInteraction): string {
  return interaction.user.globalName ?? interaction.user.username
}

function shuffledTiles(): string[] {
  const tiles = [...MEMORY_SYMBOLS, ...MEMORY_SYMBOLS]
  for (let i = tiles.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[tiles[i], tiles[j]] = [tiles[j] ?? '?', tiles[i] ?? '?']
  }
  return tiles
}

function parseTileId(customId: string): { token: string; index: number } | null {
  const [base, token, indexRaw] = customId.split(':')
  const index = Number.parseInt(indexRaw ?? '', 10)
  if (base !== MEMORY_TILE_BUTTON_ID || !token || !isTileIndex(index)) return null
  return { token, index }
}

function isDone(state: MemoryState): boolean {
  return state.matched.length === MEMORY_SIZE
}

function isVisible(state: MemoryState, index: number): boolean {
  return state.matched.includes(index) || state.selected.includes(index)
}

function statusText(state: MemoryState): string {
  if (isDone(state)) return `${state.chooser} cleared the board in ${state.moves} moves.`
  if (state.lastResult) return state.lastResult
  if (state.selected.length === 1) return 'Pick one more tile.'
  return 'Find all matching pairs.'
}

function tileButton(token: string, state: MemoryState, index: number): ButtonBuilder {
  const visible = isVisible(state, index)
  const matched = state.matched.includes(index)

  return new ButtonBuilder()
    .setCustomId(`${MEMORY_TILE_BUTTON_ID}:${token}:${index}`)
    .setLabel(visible ? state.tiles[index] ?? '?' : '?')
    .setStyle(matched ? ButtonStyle.Success : visible ? ButtonStyle.Primary : ButtonStyle.Secondary)
    .setDisabled(matched || isDone(state))
}

function buildComponents(token: string, state: MemoryState): MemoryComponent[] {
  const container = new ContainerBuilder()
    .setAccentColor(MEMORY_COLOR)
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(`## Memory match\nMoves: ${state.moves}\n${statusText(state)}`)
    )
    .addSeparatorComponents(new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small).setDivider(true))
    .addTextDisplayComponents(new TextDisplayBuilder().setContent(`-# \`${state.commandInput}\``))

  const rows = Array.from({ length: MEMORY_WIDTH }, (_, row) => {
    const start = row * MEMORY_WIDTH
    return new ActionRowBuilder<ButtonBuilder>().addComponents(
      tileButton(token, state, start),
      tileButton(token, state, start + 1),
      tileButton(token, state, start + 2),
      tileButton(token, state, start + 3)
    )
  })

  return withPubtabButton([container, ...rows], state.pubtab)
}

function buildExpiredComponents(): MemoryComponent[] {
  return [
    new ContainerBuilder()
      .setAccentColor(MEMORY_COLOR)
      .addTextDisplayComponents(new TextDisplayBuilder().setContent('## Memory match\nGame expired.'))
  ]
}

export function isMemoryButtonId(customId: string): boolean {
  return customId.startsWith(`${MEMORY_TILE_BUTTON_ID}:`)
}

export async function handleMemoryButton(interaction: ButtonInteraction): Promise<void> {
  const parsed = parseTileId(interaction.customId)
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

  if (state.selected.length >= 2 && !isDone(state)) {
    state.selected = []
  }

  if (!state.matched.includes(parsed.index) && !state.selected.includes(parsed.index) && !isDone(state)) {
    state.selected.push(parsed.index)
    state.chooser = displayName(interaction)
    state.lastResult = undefined

    if (state.selected.length === 2) {
      state.moves++
      const [left, right] = state.selected
      if (state.tiles[left] === state.tiles[right]) {
        state.matched.push(left, right)
        state.selected = []
        state.lastResult = isDone(state) ? undefined : 'Match found.'
      } else {
        state.lastResult = 'No match. Pick another tile to hide them.'
      }
    }
  }

  storeState(parsed.token, state)
  await interaction.update({
    components: buildComponents(parsed.token, state) as never,
    flags: MessageFlags.IsComponentsV2
  })
}

export const subcommand: Subcommand = {
  name: 'memory',
  description: 'memory matching game',
  usage: 'memory [--pub]',
  examples: ['memory', 'memory --pub'],
  pubtab: { label: 'Memory', args: '' },

  async execute(interaction, args, flags) {
    const token = randomUUID().replace(/-/g, '').slice(0, 16)
    const state: MemoryState = {
      commandInput: args,
      pub: flags.has('pub'),
      pubtab: isPubtabContext(flags),
      tiles: shuffledTiles(),
      matched: [],
      selected: [],
      moves: 0,
      chooser: interaction.user.globalName ?? interaction.user.username
    }

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
