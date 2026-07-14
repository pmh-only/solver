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
import { getStoredValue, setStoredValue } from '../helpers/kv-store.js'

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
type TttComponent = ContainerBuilder | ActionRowBuilder<ButtonBuilder>

interface TttState {
  mode: TttMode
  commandInput: string
  pub: boolean
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
      board,
      turn: parsed.turn,
      xPlayerId: parsed.xPlayerId,
      xPlayerName: parsed.xPlayerName,
      oPlayerId: typeof parsed.oPlayerId === 'string' ? parsed.oPlayerId : undefined,
      oPlayerName: typeof parsed.oPlayerName === 'string' ? parsed.oPlayerName : undefined,
      result: parsed.result === 'X' || parsed.result === 'O' || parsed.result === 'draw' ? parsed.result : undefined
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
  return symbol === 'X' ? '❌' : '⭕'
}

function boardLine(board: (TttSymbol | null)[]): string {
  return board.map((symbol, index) => (symbol ? symbolLabel(symbol) : `${index + 1}`)).join(' | ')
}

function winnerFromMove(board: (TttSymbol | null)[], symbol: TttSymbol): boolean {
  return WIN_LINES.some(([a, b, c]) => board[a] === symbol && board[b] === symbol && board[c] === symbol)
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

function buildCellButton(token: string, state: TttState, index: number, symbol?: TttSymbol): ButtonBuilder {
  const filled = symbol ?? state.board[index]

  return new ButtonBuilder()
    .setCustomId(`${TTT_MOVE_BUTTON_ID}:${token}:${index}`)
    .setLabel(filled ? symbolLabel(filled) : `${index + 1}`)
    .setStyle(
      filled
        ? filled === 'X'
          ? ButtonStyle.Primary
          : ButtonStyle.Danger
        : ButtonStyle.Secondary
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

function buildComponents(token: string, state: TttState): TttComponent[] {
  const container = new ContainerBuilder()
    .setAccentColor(TTT_COLOR)
    .addTextDisplayComponents(new TextDisplayBuilder().setContent(`# Tic tac toe\n${statusText(state)}`))
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(`
${boardLine(state.board.slice(0, 3))}
${boardLine(state.board.slice(3, 6))}
${boardLine(state.board.slice(6, 9))}`.trim())
    )
    .addSeparatorComponents(new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small).setDivider(true))
    .addTextDisplayComponents(new TextDisplayBuilder().setContent(`-# \`${state.commandInput}\``))

  const rows = buildBoardRows(token, state)
  return [container, ...rows]
}

function buildExpiredComponents(): TttComponent[] {
  return [
    new ContainerBuilder()
      .setAccentColor(TTT_COLOR)
      .addTextDisplayComponents(new TextDisplayBuilder().setContent('# Tic tac toe\nGame expired.'))
  ]
}

function nextRandomMove(board: (TttSymbol | null)[]): number {
  const open: number[] = []
  for (let i = 0; i < board.length; i++) {
    if (board[i] === null) open.push(i)
  }
  return open[Math.floor(Math.random() * open.length)] ?? 0
}

function makeReplyComponents(token: string, state: TttState): TttComponent[] {
  return buildComponents(token, state)
}

function buildErrorContainer(message: string): ContainerBuilder {
  return new ContainerBuilder()
    .setAccentColor(TTT_COLOR)
    .addTextDisplayComponents(new TextDisplayBuilder().setContent(`## Tic tac toe\n${message}`))
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
    await interaction.reply({
      components: buildExpiredComponents() as never,
      flags: [MessageFlags.IsComponentsV2, MessageFlags.Ephemeral]
    })
    return
  }

  const state = loadState(move.token)
  if (!state) {
    await interaction.reply({
      components: buildExpiredComponents() as never,
      flags: [MessageFlags.IsComponentsV2, MessageFlags.Ephemeral]
    })
    return
  }

  const symbol = symbolForUser(state, interaction)
  if (!symbol) {
    if (state.mode === 'pc') {
      await interaction.reply({
        components: [buildErrorContainer('Only the command user can play in PC mode.') as TttComponent] as never,
        flags: [MessageFlags.IsComponentsV2, MessageFlags.Ephemeral]
      })
      return
    }

    await interaction.reply({
      components: [buildErrorContainer('Game has two players already.') as TttComponent] as never,
      flags: [MessageFlags.IsComponentsV2, MessageFlags.Ephemeral]
    })
    return
  }

  if (state.result) {
    await interaction.reply({
      components: [buildErrorContainer('This game is already finished.') as TttComponent] as never,
      flags: [MessageFlags.IsComponentsV2, MessageFlags.Ephemeral]
    })
    return
  }

  if (state.board[move.index] !== null) {
    await interaction.reply({
      components: [buildErrorContainer('That tile is already taken.') as TttComponent] as never,
      flags: [MessageFlags.IsComponentsV2, MessageFlags.Ephemeral]
    })
    return
  }

  if (symbol !== state.turn) {
    await interaction.reply({
      components: [buildErrorContainer("It's not your turn yet.") as TttComponent] as never,
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
  await interaction.update({
    components: makeReplyComponents(move.token, state) as never,
    flags: MessageFlags.IsComponentsV2
  })
}

function buildInitialState(interaction: CommandInteraction, mode: TttMode, args: string, pub: boolean): TttState {
  return {
    mode,
    commandInput: args,
    pub,
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
    const restArgs = args.replace(/^\S+\s*/, '').trim().toLowerCase()
    const pub = flags.has('pub')
    const mode = parseMode(restArgs, flags.has('pc'))
    const token = randomUUID().replace(/-/g, '').slice(0, 16)
    const state = buildInitialState(interaction, mode, args, pub)

    if (mode === 'pc') {
      state.turn = 'X'
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
