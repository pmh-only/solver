import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  MessageFlags,
  StringSelectMenuBuilder,
  StringSelectMenuOptionBuilder,
  type ButtonInteraction,
  type StringSelectMenuInteraction
} from 'discord.js'
import { randomUUID } from 'node:crypto'
import { Chess, type Color, type Move, type PieceSymbol, type Square } from 'chess.js'
import type { Subcommand } from '../types.js'
import {
  deleteStoredValue,
  getStoredValue,
  listStoredKeys,
  setStoredValue
} from '../helpers/kv-store.js'
import {
  createGamePresentation,
  type GameControl,
  type GamePresentation
} from '../canvas-presentation.js'

export const CHESS_ACTION_BUTTON_ID = 'chess-action'
export const CHESS_PIECE_SELECT_ID = 'chess-piece'
export const CHESS_MOVE_SELECT_ID = 'chess-move'

const CHESS_STATE_KEY = '__chess-state'
const CHESS_STATE_TTL_MS = 7 * 24 * 60 * 60 * 1000
const MOVES_PER_PAGE = 25
const MAX_STORED_MOVES = 10_000
const activeGameTokens = new Set<string>()
const expirationTimers = new Map<string, ReturnType<typeof setTimeout>>()

type ChessAction = 'join' | 'cancel' | 'back' | 'previous' | 'next' | 'resign'
type PromotionPiece = 'q' | 'r' | 'b' | 'n'

interface ChessPlayer {
  id: string
  name: string
}

interface StoredChessMove {
  from: Square
  to: Square
  promotion?: PromotionPiece
}

interface ChessSelection {
  square: Square
  userId: string
  page: number
}

interface ChessState {
  commandInput: string
  white: ChessPlayer
  black?: ChessPlayer
  moves: StoredChessMove[]
  selected?: ChessSelection
  result?: { type: 'resigned'; winner: Color } | { type: 'cancelled' }
  updatedAt: number
}

interface LoadedChessState {
  state: ChessState
  game: Chess
}

const PIECE_NAMES: Record<PieceSymbol, string> = {
  p: 'Pawn',
  n: 'Knight',
  b: 'Bishop',
  r: 'Rook',
  q: 'Queen',
  k: 'King'
}

const PROMOTION_NAMES: Record<PromotionPiece, string> = {
  q: 'Queen',
  r: 'Rook',
  b: 'Bishop',
  n: 'Knight'
}

function stateKey(token: string): string {
  return `${CHESS_STATE_KEY}:${token}`
}

function deleteState(token: string): void {
  const timer = expirationTimers.get(token)
  if (timer) clearTimeout(timer)
  expirationTimers.delete(token)
  deleteStoredValue(stateKey(token))
}

function scheduleStateExpiry(token: string, updatedAt: number): void {
  const existing = expirationTimers.get(token)
  if (existing) clearTimeout(existing)
  const timer = setTimeout(
    () => deleteState(token),
    Math.max(1, updatedAt + CHESS_STATE_TTL_MS - Date.now())
  )
  timer.unref()
  expirationTimers.set(token, timer)
}

function playerFromInteraction(interaction: ButtonInteraction): ChessPlayer {
  return {
    id: interaction.user.id,
    name: interaction.user.globalName ?? interaction.user.username
  }
}

function isSquare(value: unknown): value is Square {
  return typeof value === 'string' && /^[a-h][1-8]$/.test(value)
}

function isPromotion(value: unknown): value is PromotionPiece {
  return value === 'q' || value === 'r' || value === 'b' || value === 'n'
}

function parsePlayer(value: unknown): ChessPlayer | null {
  if (!value || typeof value !== 'object') return null
  const player = value as Partial<ChessPlayer>
  if (typeof player.id !== 'string' || !player.id) return null
  if (typeof player.name !== 'string' || !player.name) return null
  return { id: player.id, name: player.name }
}

function parseMoves(value: unknown): StoredChessMove[] | null {
  if (!Array.isArray(value) || value.length > MAX_STORED_MOVES) return null
  const moves: StoredChessMove[] = []
  for (const entry of value) {
    if (!entry || typeof entry !== 'object') return null
    const move = entry as Partial<StoredChessMove>
    if (!isSquare(move.from) || !isSquare(move.to)) return null
    if (move.promotion !== undefined && !isPromotion(move.promotion)) return null
    moves.push({
      from: move.from,
      to: move.to,
      ...(move.promotion ? { promotion: move.promotion } : {})
    })
  }
  return moves
}

function gameFromMoves(moves: StoredChessMove[]): Chess | null {
  const game = new Chess()
  try {
    for (const move of moves) game.move(move)
    return game
  } catch {
    return null
  }
}

function parseState(raw: string): LoadedChessState | null {
  try {
    const value = JSON.parse(raw) as Partial<ChessState>
    const white = parsePlayer(value.white)
    const black = value.black === undefined ? undefined : parsePlayer(value.black)
    const moves = parseMoves(value.moves)
    if (!white || (value.black !== undefined && !black) || !moves) return null
    if (typeof value.commandInput !== 'string' || !value.commandInput) return null
    if (typeof value.updatedAt !== 'number' || !Number.isFinite(value.updatedAt)) return null

    let selected: ChessSelection | undefined
    if (value.selected !== undefined) {
      if (!value.selected || typeof value.selected !== 'object') return null
      const candidate = value.selected as Partial<ChessSelection>
      if (
        !isSquare(candidate.square) ||
        typeof candidate.userId !== 'string' ||
        !candidate.userId ||
        !Number.isInteger(candidate.page) ||
        candidate.page! < 0
      ) {
        return null
      }
      selected = {
        square: candidate.square,
        userId: candidate.userId,
        page: candidate.page!
      }
    }

    let result: ChessState['result']
    if (value.result?.type === 'cancelled') {
      result = { type: 'cancelled' }
    } else if (
      value.result?.type === 'resigned' &&
      (value.result.winner === 'w' || value.result.winner === 'b')
    ) {
      result = { type: 'resigned', winner: value.result.winner }
    } else if (value.result !== undefined) {
      return null
    }

    const game = gameFromMoves(moves)
    if (!game) return null
    if (selected) {
      const currentPlayerId = game.turn() === 'w' ? white.id : black?.id
      const legalMoves = game.moves({ square: selected.square, verbose: true })
      if (!currentPlayerId || selected.userId !== currentPlayerId || legalMoves.length === 0) {
        selected = undefined
      } else {
        selected.page = Math.min(
          selected.page,
          Math.max(0, Math.ceil(legalMoves.length / MOVES_PER_PAGE) - 1)
        )
      }
    }
    return {
      state: {
        commandInput: value.commandInput,
        white,
        ...(black ? { black } : {}),
        moves,
        ...(selected ? { selected } : {}),
        ...(result ? { result } : {}),
        updatedAt: value.updatedAt
      },
      game
    }
  } catch {
    return null
  }
}

function loadState(token: string): LoadedChessState | null {
  const key = stateKey(token)
  const raw = getStoredValue(key)
  if (!raw) return null
  const loaded = parseState(raw)
  if (!loaded || Date.now() - loaded.state.updatedAt > CHESS_STATE_TTL_MS) {
    deleteState(token)
    return null
  }
  scheduleStateExpiry(token, loaded.state.updatedAt)
  return loaded
}

function storeState(token: string, state: ChessState): void {
  state.updatedAt = Date.now()
  setStoredValue(stateKey(token), JSON.stringify(state))
  scheduleStateExpiry(token, state.updatedAt)
}

function cleanupExpiredStates(): void {
  const now = Date.now()
  for (const key of listStoredKeys()) {
    if (!key.startsWith(`${CHESS_STATE_KEY}:`)) continue
    const raw = getStoredValue(key)
    const loaded = raw ? parseState(raw) : null
    if (!loaded || now - loaded.state.updatedAt > CHESS_STATE_TTL_MS) {
      deleteState(key.slice(`${CHESS_STATE_KEY}:`.length))
    } else {
      scheduleStateExpiry(key.slice(`${CHESS_STATE_KEY}:`.length), loaded.state.updatedAt)
    }
  }
}

function escapeMarkdown(value: string): string {
  return value.replace(/([\\`*_[\]])/g, '\\$1').replaceAll('@', '@\u200b')
}

function playerForColor(state: ChessState, color: Color): ChessPlayer | undefined {
  return color === 'w' ? state.white : state.black
}

function colorForUser(state: ChessState, userId: string): Color | null {
  if (state.white.id === userId) return 'w'
  if (state.black?.id === userId) return 'b'
  return null
}

function sideName(color: Color): string {
  return color === 'w' ? 'White' : 'Black'
}

function moveDescription(move: Move): string {
  if (move.isKingsideCastle()) return `Castle kingside, moving the king ${move.from} to ${move.to}`
  if (move.isQueensideCastle()) {
    return `Castle queenside, moving the king ${move.from} to ${move.to}`
  }
  const capture = move.captured ? `, capturing ${PIECE_NAMES[move.captured].toLowerCase()}` : ''
  const promotion = isPromotion(move.promotion)
    ? `, promoting to ${PROMOTION_NAMES[move.promotion].toLowerCase()}`
    : ''
  return `${PIECE_NAMES[move.piece]} ${move.from} to ${move.to}${capture}${promotion}`
}

function lastMoveLine(game: Chess): string | null {
  const last = game.history({ verbose: true }).at(-1)
  return last ? `Last move: ${sideName(last.color)} ${moveDescription(last)}.` : null
}

function drawReason(game: Chess): string {
  if (game.isStalemate()) return 'Draw by stalemate.'
  if (game.isInsufficientMaterial()) return 'Draw by insufficient material.'
  if (game.isThreefoldRepetition()) return 'Draw by threefold repetition.'
  if (game.isDrawByFiftyMoves()) return 'Draw by the fifty-move rule.'
  return 'Draw.'
}

function finishedLine(state: ChessState, game: Chess): string | null {
  if (state.result?.type === 'cancelled') return 'Challenge cancelled.'
  if (state.result?.type === 'resigned') {
    const winner = playerForColor(state, state.result.winner)
    return `${winner ? escapeMarkdown(winner.name) : sideName(state.result.winner)} wins by resignation.`
  }
  if (game.isCheckmate()) {
    const winnerColor: Color = game.turn() === 'w' ? 'b' : 'w'
    const winner = playerForColor(state, winnerColor)
    return `Checkmate. ${winner ? escapeMarkdown(winner.name) : sideName(winnerColor)} wins as ${sideName(winnerColor)}.`
  }
  if (game.isDraw()) return drawReason(game)
  return null
}

function isFinished(state: ChessState, game: Chess): boolean {
  return Boolean(state.result) || game.isGameOver()
}

function statusLines(state: ChessState, game: Chess): string[] {
  const finished = finishedLine(state, game)
  const lastMove = lastMoveLine(game)
  const players = state.black
    ? `White: **${escapeMarkdown(state.white.name)}** · Black: **${escapeMarkdown(state.black.name)}**`
    : `White: **${escapeMarkdown(state.white.name)}** · Black: waiting for a player`
  if (finished) return [players, finished, ...(lastMove ? [lastMove] : [])]
  if (!state.black) return [players, 'Choose **Join as Black** to accept the challenge.']

  const current = playerForColor(state, game.turn())!
  const check = game.isCheck() ? ' The king is in check.' : ''
  const instruction = state.selected
    ? `${escapeMarkdown(current.name)} selected ${PIECE_NAMES[game.get(state.selected.square)!.type]} on **${state.selected.square}**. Choose a legal destination.${check}`
    : `${escapeMarkdown(current.name)} to move as **${sideName(game.turn())}**. Choose a movable piece.${check}`
  return [players, instruction, ...(lastMove ? [lastMove] : [])]
}

function accessibleBoard(game: Chess): string {
  const pieces = game
    .board()
    .flat()
    .flatMap((piece) =>
      piece ? [`${piece.square}: ${sideName(piece.color)} ${PIECE_NAMES[piece.type]}`] : []
    )
  return `Board: ${pieces.join('; ')}. Empty squares are omitted.`
}

function movablePieces(game: Chess): Array<{ square: Square; piece: PieceSymbol; moves: number }> {
  const bySquare = new Map<Square, { piece: PieceSymbol; moves: number }>()
  for (const move of game.moves({ verbose: true })) {
    const current = bySquare.get(move.from)
    bySquare.set(move.from, { piece: move.piece, moves: (current?.moves ?? 0) + 1 })
  }
  return [...bySquare.entries()]
    .map(([square, value]) => ({ square, ...value }))
    .sort((left, right) => left.square.localeCompare(right.square))
}

function pieceSelectRow(token: string, game: Chess): GameControl {
  const options = movablePieces(game).map(({ square, piece, moves }) =>
    new StringSelectMenuOptionBuilder()
      .setLabel(`${PIECE_NAMES[piece]} on ${square}`)
      .setDescription(`${moves} legal move${moves === 1 ? '' : 's'}`)
      .setValue(square)
  )
  return new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId(`${CHESS_PIECE_SELECT_ID}:${token}`)
      .setPlaceholder(`Choose a ${sideName(game.turn()).toLowerCase()} piece`)
      .addOptions(options)
  )
}

function selectedMoves(game: Chess, selection: ChessSelection): Move[] {
  return game.moves({ square: selection.square, verbose: true })
}

function moveValue(move: Move, revision: number): string {
  return `${move.from}:${move.to}:${move.promotion ?? '-'}:${revision}`
}

function moveSelectRow(token: string, state: ChessState, game: Chess): GameControl {
  const moves = selectedMoves(game, state.selected!)
  const pages = Math.max(1, Math.ceil(moves.length / MOVES_PER_PAGE))
  const page = Math.min(state.selected!.page, pages - 1)
  const options = moves.slice(page * MOVES_PER_PAGE, (page + 1) * MOVES_PER_PAGE).map((move) => {
    const capture = move.isKingsideCastle()
      ? 'Castle kingside'
      : move.isQueensideCastle()
        ? 'Castle queenside'
        : move.captured
          ? `Capture on ${move.to}`
          : `Move to ${move.to}`
    const promotion = isPromotion(move.promotion)
      ? ` and promote to ${PROMOTION_NAMES[move.promotion]}`
      : ''
    return new StringSelectMenuOptionBuilder()
      .setLabel(`${capture}${promotion}`)
      .setDescription(moveDescription(move))
      .setValue(moveValue(move, state.moves.length))
  })
  return new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId(`${CHESS_MOVE_SELECT_ID}:${token}`)
      .setPlaceholder(`Choose destination · page ${page + 1}/${pages}`)
      .addOptions(options)
  )
}

function actionButton(
  token: string,
  action: ChessAction,
  label: string,
  style: ButtonStyle,
  disabled = false
): ButtonBuilder {
  return new ButtonBuilder()
    .setCustomId(`${CHESS_ACTION_BUTTON_ID}:${token}:${action}`)
    .setLabel(label)
    .setStyle(style)
    .setDisabled(disabled)
}

function gameControls(token: string, state: ChessState, game: Chess): GameControl[] {
  if (isFinished(state, game)) return []
  if (!state.black) {
    return [
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        actionButton(token, 'join', 'Join as Black', ButtonStyle.Success),
        actionButton(token, 'cancel', 'Cancel challenge', ButtonStyle.Secondary)
      )
    ]
  }

  if (!state.selected) {
    return [
      pieceSelectRow(token, game),
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        actionButton(token, 'resign', 'Resign', ButtonStyle.Danger)
      )
    ]
  }

  const moveCount = selectedMoves(game, state.selected).length
  const pages = Math.max(1, Math.ceil(moveCount / MOVES_PER_PAGE))
  return [
    moveSelectRow(token, state, game),
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      actionButton(token, 'back', 'Choose another piece', ButtonStyle.Secondary),
      actionButton(token, 'previous', 'Previous', ButtonStyle.Secondary, state.selected.page <= 0),
      actionButton(token, 'next', 'Next', ButtonStyle.Secondary, state.selected.page >= pages - 1),
      actionButton(token, 'resign', 'Resign', ButtonStyle.Danger)
    )
  ]
}

function buildPresentation(token: string, state: ChessState, game: Chess): GamePresentation {
  const history = game.history({ verbose: true })
  const last = history.at(-1)
  const checkSquare = game.isCheck()
    ? game.findPiece({ type: 'k', color: game.turn() })[0]
    : undefined
  return createGamePresentation({
    id: `chess-${token}`,
    title: 'Chess',
    kicker: finishedLine(state, game)
      ? 'Game finished'
      : state.black
        ? `${sideName(game.turn())} to move`
        : 'Open challenge',
    lines: statusLines(state, game),
    descriptionLines: [...statusLines(state, game), accessibleBoard(game)],
    footer: state.commandInput,
    visual: {
      kind: 'chess',
      board: game.board(),
      selected: state.selected?.square,
      lastMove: last ? { from: last.from, to: last.to } : undefined,
      checkSquare
    },
    controls: gameControls(token, state, game)
  })
}

function unavailablePresentation(message: string): GamePresentation {
  return createGamePresentation({
    id: 'chess-unavailable',
    title: 'Chess',
    kicker: 'Game unavailable',
    lines: [message]
  })
}

async function replyError(
  interaction: ButtonInteraction | StringSelectMenuInteraction,
  message: string
): Promise<void> {
  const presentation = unavailablePresentation(message)
  await interaction.reply({
    components: presentation.components as never,
    files: presentation.files,
    flags: [MessageFlags.IsComponentsV2, MessageFlags.Ephemeral]
  })
}

async function updateGame(
  interaction: ButtonInteraction | StringSelectMenuInteraction,
  token: string,
  state: ChessState,
  game: Chess
): Promise<void> {
  const presentation = buildPresentation(token, state, game)
  storeState(token, state)
  await interaction.update({
    components: presentation.components as never,
    files: presentation.files,
    attachments: [],
    flags: MessageFlags.IsComponentsV2
  })
  if (isFinished(state, game)) deleteState(token)
}

function parseAction(customId: string): { token: string; action: ChessAction } | null {
  const [base, token, action, extra] = customId.split(':')
  if (base !== CHESS_ACTION_BUTTON_ID || !token || extra) return null
  if (
    action !== 'join' &&
    action !== 'cancel' &&
    action !== 'back' &&
    action !== 'previous' &&
    action !== 'next' &&
    action !== 'resign'
  ) {
    return null
  }
  return { token, action }
}

function selectToken(customId: string, baseId: string): string | null {
  const [base, token, extra] = customId.split(':')
  return base === baseId && token && !extra ? token : null
}

function canMove(state: ChessState, game: Chess, userId: string): boolean {
  return playerForColor(state, game.turn())?.id === userId
}

export function isChessButtonId(customId: string): boolean {
  return customId.startsWith(`${CHESS_ACTION_BUTTON_ID}:`)
}

export function isChessSelectId(customId: string): boolean {
  return (
    customId.startsWith(`${CHESS_PIECE_SELECT_ID}:`) ||
    customId.startsWith(`${CHESS_MOVE_SELECT_ID}:`)
  )
}

export async function handleChessButton(interaction: ButtonInteraction): Promise<void> {
  const parsed = parseAction(interaction.customId)
  if (!parsed) {
    await replyError(interaction, 'Game expired. Start a new game with `chess`.')
    return
  }
  if (activeGameTokens.has(parsed.token)) {
    await replyError(interaction, 'Another move is being processed. Try again.')
    return
  }
  activeGameTokens.add(parsed.token)
  try {
    const loaded = loadState(parsed.token)
    if (!loaded) {
      await replyError(interaction, 'Game expired. Start a new game with `chess`.')
      return
    }
    const { state, game } = loaded
    if (isFinished(state, game)) {
      await updateGame(interaction, parsed.token, state, game)
      return
    }

    if (parsed.action === 'join') {
      if (state.black) {
        await updateGame(interaction, parsed.token, state, game)
        return
      }
      if (state.white.id === interaction.user.id) {
        await replyError(interaction, 'The White player cannot also join as Black.')
        return
      }
      state.black = playerFromInteraction(interaction)
      await updateGame(interaction, parsed.token, state, game)
      return
    }

    if (parsed.action === 'cancel') {
      if (state.black) {
        await updateGame(interaction, parsed.token, state, game)
        return
      }
      if (state.white.id !== interaction.user.id) {
        await replyError(interaction, 'Only the White player can cancel an open challenge.')
        return
      }
      state.result = { type: 'cancelled' }
      state.selected = undefined
      await updateGame(interaction, parsed.token, state, game)
      return
    }

    const color = colorForUser(state, interaction.user.id)
    if (!color) {
      await replyError(interaction, 'Only the two players can control this game.')
      return
    }

    if (parsed.action === 'resign') {
      if (!state.black) {
        await replyError(interaction, 'Wait for an opponent before resigning.')
        return
      }
      state.result = { type: 'resigned', winner: color === 'w' ? 'b' : 'w' }
      state.selected = undefined
      await updateGame(interaction, parsed.token, state, game)
      return
    }

    if (
      !state.selected ||
      state.selected.userId !== interaction.user.id ||
      !canMove(state, game, interaction.user.id)
    ) {
      if (!state.selected && canMove(state, game, interaction.user.id)) {
        await updateGame(interaction, parsed.token, state, game)
        return
      }
      await replyError(interaction, "It's not your active move selection.")
      return
    }

    if (parsed.action === 'back') {
      state.selected = undefined
    } else {
      const pages = Math.max(
        1,
        Math.ceil(selectedMoves(game, state.selected).length / MOVES_PER_PAGE)
      )
      state.selected.page = Math.max(
        0,
        Math.min(pages - 1, state.selected.page + (parsed.action === 'next' ? 1 : -1))
      )
    }
    await updateGame(interaction, parsed.token, state, game)
  } finally {
    activeGameTokens.delete(parsed.token)
  }
}

export async function handleChessSelect(interaction: StringSelectMenuInteraction): Promise<void> {
  const pieceToken = selectToken(interaction.customId, CHESS_PIECE_SELECT_ID)
  const moveToken = selectToken(interaction.customId, CHESS_MOVE_SELECT_ID)
  const token = pieceToken ?? moveToken
  if (!token) {
    await replyError(interaction, 'Game expired. Start a new game with `chess`.')
    return
  }
  if (activeGameTokens.has(token)) {
    await replyError(interaction, 'Another move is being processed. Try again.')
    return
  }
  activeGameTokens.add(token)
  try {
    const loaded = loadState(token)
    if (!loaded) {
      await replyError(interaction, 'Game expired. Start a new game with `chess`.')
      return
    }
    const { state, game } = loaded
    if (isFinished(state, game)) {
      await updateGame(interaction, token, state, game)
      return
    }
    if (!state.black) {
      await replyError(interaction, 'Waiting for Black to join.')
      return
    }
    if (!canMove(state, game, interaction.user.id)) {
      await replyError(interaction, "It's not your turn yet.")
      return
    }

    const value = interaction.values[0]
    if (pieceToken) {
      if (!isSquare(value) || game.moves({ square: value, verbose: true }).length === 0) {
        await updateGame(interaction, token, state, game)
        return
      }
      state.selected = { square: value, userId: interaction.user.id, page: 0 }
      await updateGame(interaction, token, state, game)
      return
    }

    if (!state.selected || state.selected.userId !== interaction.user.id) {
      await updateGame(interaction, token, state, game)
      return
    }
    const [from, to, promotionRaw, revisionRaw, extra] = (value ?? '').split(':')
    const promotion = isPromotion(promotionRaw) ? promotionRaw : undefined
    const revision = Number(revisionRaw)
    if (
      !isSquare(from) ||
      !isSquare(to) ||
      extra ||
      (promotionRaw !== '-' && !promotion) ||
      !Number.isInteger(revision) ||
      revision !== state.moves.length ||
      from !== state.selected.square
    ) {
      await updateGame(interaction, token, state, game)
      return
    }
    const legalMove = selectedMoves(game, state.selected).find(
      (move) => move.to === to && move.promotion === promotion
    )
    if (!legalMove) {
      await updateGame(interaction, token, state, game)
      return
    }
    if (state.moves.length >= MAX_STORED_MOVES) {
      await replyError(interaction, 'This game reached the supported move limit.')
      return
    }

    const made = game.move({
      from: state.selected.square,
      to,
      ...(promotion ? { promotion } : {})
    })
    state.moves.push({
      from: made.from,
      to: made.to,
      ...(isPromotion(made.promotion) ? { promotion: made.promotion } : {})
    })
    state.selected = undefined
    await updateGame(interaction, token, state, game)
  } finally {
    activeGameTokens.delete(token)
  }
}

export const subcommand: Subcommand = {
  name: 'chess',
  description: 'play two-player chess with dropdown moves',
  usage: 'chess',
  examples: ['chess'],

  async execute(interaction, args) {
    const input = args.replace(/^\S+\s*/, '').trim()
    if (input) {
      const presentation = unavailablePresentation('Chess does not take arguments. Use `chess`.')
      await interaction.reply({
        components: presentation.components as never,
        files: presentation.files,
        flags: [MessageFlags.IsComponentsV2, MessageFlags.Ephemeral]
      })
      return
    }

    cleanupExpiredStates()
    const token = randomUUID().replace(/-/g, '').slice(0, 16)
    const state: ChessState = {
      commandInput: args,
      white: {
        id: interaction.user.id,
        name: interaction.user.globalName ?? interaction.user.username
      },
      moves: [],
      updatedAt: Date.now()
    }
    storeState(token, state)
    const presentation = buildPresentation(token, state, new Chess())

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
      flags: [MessageFlags.IsComponentsV2]
    })
  }
}
