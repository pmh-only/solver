import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  MessageFlags,
  type ButtonInteraction
} from 'discord.js'
import { randomUUID } from 'node:crypto'
import type { CommandInteraction, Subcommand } from '../types.js'
import { getStoredValue, setStoredValue } from '../helpers/kv-store.js'
import { isPubtabContext } from '../flags.js'
import { withPubtabButton } from '../components.js'
import { createGamePresentation, type GamePresentation } from '../canvas-presentation.js'

export const TTT_MOVE_BUTTON_ID = 'ttt-move'

const TTT_STATE_KEY = 'ttt'
const TTT_COLOR = 0x4f46e5
const TTT_SIZE = 9
const WIN_LINES: [number, number, number][] = [
  [0, 1, 2],
  [3, 4, 5],
  [6, 7, 8],
  [0, 3, 6],
  [1, 4, 7],
  [2, 5, 8],
  [0, 4, 8],
  [2, 4, 6]
]

type TttSymbol = 'X' | 'O'
type TttMode = 'pc' | 'duel'
type TttOutcome = TttSymbol | 'draw'
interface TttState {
  mode: TttMode
  commandInput: string
  pub: boolean
  pubtab: boolean
  board: (TttSymbol | null)[]
  turn: TttSymbol
  xPlayerId: string
  xPlayerName: string
  oPlayerId?: string
  oPlayerName?: string
  result?: TttOutcome
}

interface Move {
  token: string
  index: number
}

function stateKey(token: string): string {
  return `${TTT_STATE_KEY}:${token}`
}

function storeState(token: string, state: TttState): void {
  setStoredValue(stateKey(token), JSON.stringify(state))
}

function parseBoard(board: unknown): (TttSymbol | null)[] | null {
  if (!Array.isArray(board)) return null
  if (board.length !== TTT_SIZE) return null

  return board.map((cell) => (cell === 'X' || cell === 'O' ? cell : null))
}

function isSymbol(value: string | null | undefined): value is TttSymbol {
  return value === 'X' || value === 'O'
}

function parseMode(value: string, preferPc: boolean): TttMode {
  if (value === 'pc' || preferPc) return 'pc'
  if (value === 'duel') return 'duel'
  return 'duel'
}

function loadState(token: string): TttState | null {
  const stored = getStoredValue(stateKey(token))
  if (!stored) return null

  try {
    const parsed = JSON.parse(stored) as Partial<TttState>
    const board = parseBoard(parsed.board)
    if (!board) return null
    if (parsed.mode !== 'pc' && parsed.mode !== 'duel') return null
    if (typeof parsed.commandInput !== 'string') return null
    if (typeof parsed.xPlayerId !== 'string' || typeof parsed.xPlayerName !== 'string') return null
    if (!isSymbol(parsed.turn)) return null

    return {
      mode: parsed.mode,
      commandInput: parsed.commandInput,
      pub: Boolean(parsed.pub),
      pubtab: Boolean(parsed.pubtab),
      board,
      turn: parsed.turn,
      xPlayerId: parsed.xPlayerId,
      xPlayerName: parsed.xPlayerName,
      oPlayerId: typeof parsed.oPlayerId === 'string' ? parsed.oPlayerId : undefined,
      oPlayerName: typeof parsed.oPlayerName === 'string' ? parsed.oPlayerName : undefined,
      result:
        parsed.result === 'X' || parsed.result === 'O' || parsed.result === 'draw'
          ? parsed.result
          : undefined
    }
  } catch {
    return null
  }
}

function symbolForUser(state: TttState, interaction: ButtonInteraction): TttSymbol | null {
  const userId = interaction.user.id
  if (state.mode === 'pc') {
    return userId === state.xPlayerId ? 'X' : null
  }

  if (userId === state.xPlayerId) return 'X'
  if (state.oPlayerId && userId === state.oPlayerId) return 'O'

  if (!state.oPlayerId) {
    state.oPlayerId = userId
    state.oPlayerName = interaction.user.globalName ?? interaction.user.username
    return 'O'
  }

  return null
}

function isMove(customId: string): Move | null {
  const [base, token, indexRaw] = customId.split(':')
  if (base !== TTT_MOVE_BUTTON_ID || !token || !indexRaw) return null

  const index = Number.parseInt(indexRaw, 10)
  return Number.isInteger(index) && index >= 0 && index < TTT_SIZE ? { token, index } : null
}

function symbolLabel(symbol: TttSymbol): string {
  return symbol
}

function winnerFromMove(board: (TttSymbol | null)[], symbol: TttSymbol): boolean {
  return WIN_LINES.some(
    ([a, b, c]) => board[a] === symbol && board[b] === symbol && board[c] === symbol
  )
}

function isDraw(board: (TttSymbol | null)[]): boolean {
  return board.every((cell) => cell !== null)
}

function playerName(state: TttState, symbol: TttSymbol): string {
  if (symbol === 'X') return state.xPlayerName
  if (state.oPlayerName) return state.oPlayerName
  return state.mode === 'pc' ? 'PC' : 'Opponent'
}

function statusText(state: TttState): string {
  if (state.result === 'draw') return 'Draw. No moves left.'
  if (state.result === 'X' || state.result === 'O') {
    return `${playerName(state, state.result)} won as ${symbolLabel(state.result)}.`
  }

  if (state.mode === 'duel' && !state.oPlayerId) {
    return 'Waiting for a second player. Click any empty tile to join.'
  }

  const current = state.turn === 'X' ? state.xPlayerName : playerName(state, state.turn)
  return `${current}'s turn (${state.turn}).`
}

function accessibleBoard(board: (TttSymbol | null)[]): string {
  const rows = Array.from({ length: 3 }, (_, row) =>
    board
      .slice(row * 3, row * 3 + 3)
      .map((mark, column) => mark ?? `empty ${row * 3 + column + 1}`)
      .join(', ')
  )
  return `Board: ${rows.join(' / ')}`
}

function buildCellButton(
  token: string,
  state: TttState,
  index: number,
  symbol?: TttSymbol
): ButtonBuilder {
  const filled = symbol ?? state.board[index]

  return new ButtonBuilder()
    .setCustomId(`${TTT_MOVE_BUTTON_ID}:${token}:${index}`)
    .setLabel(`${index + 1}`)
    .setStyle(
      filled ? (filled === 'X' ? ButtonStyle.Primary : ButtonStyle.Danger) : ButtonStyle.Secondary
    )
    .setDisabled(Boolean(state.result) || Boolean(filled))
}

function buildBoardRows(token: string, state: TttState): ActionRowBuilder<ButtonBuilder>[] {
  const rows: ActionRowBuilder<ButtonBuilder>[] = []
  for (let row = 0; row < 3; row++) {
    const start = row * 3
    const actionRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
      [start, start + 1, start + 2].map((index) => buildCellButton(token, state, index))
    )
    rows.push(actionRow)
  }
  return rows
}

function buildComponents(token: string, state: TttState): GamePresentation {
  const presentation = createGamePresentation({
    id: `ttt-${token}`,
    title: 'Tic tac toe',
    kicker: state.mode === 'pc' ? 'Player vs PC' : 'Two player duel',
    lines: [statusText(state), 'Choose a numbered square below to make your move.'],
    descriptionLines: [
      statusText(state),
      accessibleBoard(state.board),
      'Choose a numbered square below to make your move.'
    ],
    accent: TTT_COLOR,
    footer: state.commandInput,
    visual: {
      kind: 'ttt',
      board: state.board,
      winner: state.result === 'X' || state.result === 'O' ? state.result : undefined
    },
    controls: buildBoardRows(token, state)
  })
  presentation.components = withPubtabButton(presentation.components, state.pubtab)
  return presentation
}

function buildExpiredComponents(): GamePresentation {
  return createGamePresentation({
    id: 'ttt-expired',
    title: 'Tic tac toe',
    kicker: 'Game unavailable',
    lines: ['Game expired. Start a new game with `ttt`.'],
    accent: TTT_COLOR,
    visual: { kind: 'ttt', board: Array(TTT_SIZE).fill(null) }
  })
}

function nextRandomMove(board: (TttSymbol | null)[]): number {
  const open: number[] = []
  for (let i = 0; i < board.length; i++) {
    if (board[i] === null) open.push(i)
  }
  return open[Math.floor(Math.random() * open.length)] ?? 0
}

function makeReplyComponents(token: string, state: TttState): GamePresentation {
  return buildComponents(token, state)
}

function buildErrorContainer(message: string): GamePresentation {
  return createGamePresentation({
    id: 'ttt-error',
    title: 'Tic tac toe',
    kicker: 'Move blocked',
    lines: [message],
    accent: TTT_COLOR
  })
}

export function isTttMoveButtonId(customId: string): boolean {
  return customId.startsWith(`${TTT_MOVE_BUTTON_ID}:`)
}

function playerDisplayName(interaction: CommandInteraction): string {
  return interaction.user.globalName ?? interaction.user.username
}

export async function handleTttMoveButton(interaction: ButtonInteraction): Promise<void> {
  const move = isMove(interaction.customId)
  if (!move) {
    const expired = buildExpiredComponents()
    await interaction.reply({
      components: expired.components as never,
      files: expired.files,
      flags: [MessageFlags.IsComponentsV2, MessageFlags.Ephemeral]
    })
    return
  }

  const state = loadState(move.token)
  if (!state) {
    const expired = buildExpiredComponents()
    await interaction.reply({
      components: expired.components as never,
      files: expired.files,
      flags: [MessageFlags.IsComponentsV2, MessageFlags.Ephemeral]
    })
    return
  }

  const symbol = symbolForUser(state, interaction)
  if (!symbol) {
    if (state.mode === 'pc') {
      const error = buildErrorContainer('Only the command user can play in PC mode.')
      await interaction.reply({
        components: error.components as never,
        files: error.files,
        flags: [MessageFlags.IsComponentsV2, MessageFlags.Ephemeral]
      })
      return
    }

    const error = buildErrorContainer('Game has two players already.')
    await interaction.reply({
      components: error.components as never,
      files: error.files,
      flags: [MessageFlags.IsComponentsV2, MessageFlags.Ephemeral]
    })
    return
  }

  if (state.result) {
    const error = buildErrorContainer('This game is already finished.')
    await interaction.reply({
      components: error.components as never,
      files: error.files,
      flags: [MessageFlags.IsComponentsV2, MessageFlags.Ephemeral]
    })
    return
  }

  if (state.board[move.index] !== null) {
    const error = buildErrorContainer('That tile is already taken.')
    await interaction.reply({
      components: error.components as never,
      files: error.files,
      flags: [MessageFlags.IsComponentsV2, MessageFlags.Ephemeral]
    })
    return
  }

  if (symbol !== state.turn) {
    const error = buildErrorContainer("It's not your turn yet.")
    await interaction.reply({
      components: error.components as never,
      files: error.files,
      flags: [MessageFlags.IsComponentsV2, MessageFlags.Ephemeral]
    })
    return
  }

  state.board[move.index] = symbol

  if (winnerFromMove(state.board, symbol)) {
    state.result = symbol
  } else if (isDraw(state.board)) {
    state.result = 'draw'
  } else {
    state.turn = symbol === 'X' ? 'O' : 'X'

    if (state.mode === 'pc' && state.turn === 'O') {
      const pcMove = nextRandomMove(state.board)
      state.board[pcMove] = 'O'
      if (winnerFromMove(state.board, 'O')) {
        state.result = 'O'
      } else if (isDraw(state.board)) {
        state.result = 'draw'
      } else {
        state.turn = 'X'
      }
    }
  }

  storeState(move.token, state)
  const presentation = makeReplyComponents(move.token, state)
  await interaction.update({
    components: presentation.components as never,
    files: presentation.files,
    attachments: [],
    flags: MessageFlags.IsComponentsV2
  })
}

function buildInitialState(
  interaction: CommandInteraction,
  mode: TttMode,
  args: string,
  pub: boolean,
  pubtab: boolean
): TttState {
  return {
    mode,
    commandInput: args,
    pub,
    pubtab,
    board: Array(TTT_SIZE).fill(null),
    turn: 'X',
    xPlayerId: interaction.user.id,
    xPlayerName: playerDisplayName(interaction)
  }
}

export const subcommand: Subcommand = {
  name: 'ttt',
  description: 'tic tac toe',
  usage: 'ttt [pc|duel] [--pc] [--pub]',
  examples: ['ttt', 'ttt --pc', 'ttt duel --pub'],
  pubtab: { label: 'TTT', args: '--pc' },
  flags: {
    pc: { description: 'play against the PC' }
  },
  async execute(interaction, args, flags) {
    const restArgs = args
      .replace(/^\S+\s*/, '')
      .trim()
      .toLowerCase()
    const pub = flags.has('pub')
    const mode = parseMode(restArgs, flags.has('pc'))
    const token = randomUUID().replace(/-/g, '').slice(0, 16)
    const state = buildInitialState(interaction, mode, args, pub, isPubtabContext(flags))

    if (mode === 'pc') {
      state.turn = 'X'
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
