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

export const MEMORY_TILE_BUTTON_ID = 'memory-tile'

const MEMORY_STATE_KEY = 'memory'
const MEMORY_SYMBOLS = ['🍎', '🍇', '🍊', '🍓', '🥝', '🍍', '🥥', '🍑'] as const
const MEMORY_NAMES = [
  'apple',
  'grape',
  'orange',
  'strawberry',
  'kiwi',
  'pineapple',
  'coconut',
  'peach'
] as const
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
      selected: Array.isArray(parsed.selected)
        ? parsed.selected.filter(isTileIndex).slice(0, 2)
        : [],
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

function tileName(value: string) {
  const index = (MEMORY_SYMBOLS as readonly string[]).indexOf(value)
  return MEMORY_NAMES[index] ?? 'symbol'
}

function accessibleBoard(state: MemoryState) {
  return state.tiles
    .map((tile, index) => {
      if (!isVisible(state, index)) return `${index + 1}: hidden`
      return `${index + 1}: ${tileName(tile)}${state.matched.includes(index) ? ' matched' : ''}`
    })
    .join(', ')
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
    .setLabel(`${index + 1}`)
    .setStyle(matched ? ButtonStyle.Success : visible ? ButtonStyle.Primary : ButtonStyle.Secondary)
    .setDisabled(matched || isDone(state))
}

function buildComponents(token: string, state: MemoryState): GamePresentation {
  const rows = Array.from({ length: MEMORY_WIDTH }, (_, row) => {
    const start = row * MEMORY_WIDTH
    return new ActionRowBuilder<ButtonBuilder>().addComponents(
      tileButton(token, state, start),
      tileButton(token, state, start + 1),
      tileButton(token, state, start + 2),
      tileButton(token, state, start + 3)
    )
  })

  const visibleTiles = state.selected.map((index) => index + 1)
  const presentation = createGamePresentation({
    id: `memory-${token}`,
    title: 'Memory match',
    kicker: `${state.moves} move${state.moves === 1 ? '' : 's'}`,
    lines: [
      statusText(state),
      ...(visibleTiles.length > 0 ? [`Revealed tiles: ${visibleTiles.join(', ')}`] : [])
    ],
    descriptionLines: [statusText(state), accessibleBoard(state)],
    footer: state.commandInput,
    visual: {
      kind: 'memory',
      cells: state.tiles.map((tile, index) => (isVisible(state, index) ? tile : null)),
      matched: state.matched
    },
    controls: rows
  })
  presentation.components = withPubtabButton(presentation.components, state.pubtab)
  return presentation
}

function buildExpiredComponents(): GamePresentation {
  return createGamePresentation({
    id: 'memory-expired',
    title: 'Memory match',
    kicker: 'Board unavailable',
    lines: ['Game expired. Start a new board with `memory`.']
  })
}

export function isMemoryButtonId(customId: string): boolean {
  return customId.startsWith(`${MEMORY_TILE_BUTTON_ID}:`)
}

export async function handleMemoryButton(interaction: ButtonInteraction): Promise<void> {
  const parsed = parseTileId(interaction.customId)
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

  if (state.selected.length >= 2 && !isDone(state)) {
    state.selected = []
  }

  if (
    !state.matched.includes(parsed.index) &&
    !state.selected.includes(parsed.index) &&
    !isDone(state)
  ) {
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
  const presentation = buildComponents(parsed.token, state)
  await interaction.update({
    components: presentation.components as never,
    files: presentation.files,
    attachments: [],
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
