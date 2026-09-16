export const SEOTDA_MAX_PLAYERS = 10
export const SEOTDA_STARTING_CHIPS = 100
export const SEOTDA_ANTE = 10
export const SEOTDA_RAISE = 10
export const SEOTDA_TURN_MS = 2 * 60 * 1000
export const SEOTDA_MAX_REDEALS = 3

export type SeotdaCardKind = 'bright' | 'animal' | 'ribbon' | 'junk'

export interface SeotdaCard {
  id: string
  month: number
  kind: SeotdaCardKind
}

export interface SeotdaPlayer {
  id: string
  name: string
  chips: number
  hand: SeotdaCard[]
  folded: boolean
  roundContribution: number
  totalContribution: number
  acted: boolean
}

export interface SeotdaResult {
  reason: 'showdown' | 'last-player' | 'cancelled'
  payouts: Record<string, number>
  lines: string[]
}

export interface SeotdaState {
  hostId: string
  channelId: string
  phase: 'lobby' | 'betting' | 'finished' | 'cancelled'
  players: SeotdaPlayer[]
  round: 0 | 1
  turnIndex: number
  dealerIndex: number
  currentBet: number
  revision: number
  redeals: number
  turnDeadline: number
  updatedAt: number
  result?: SeotdaResult
}

export type SeotdaBetAction = 'check' | 'call' | 'raise' | 'allin' | 'fold'

export interface HandRank {
  category: number
  tie: number
  name: string
  special?: 'amhaeng' | 'ddaengjabi' | 'gusa' | 'mungusa'
}

const CARD_SPECS: ReadonlyArray<[string, number, SeotdaCardKind]> = [
  ['1b', 1, 'bright'],
  ['1j', 1, 'junk'],
  ['2a', 2, 'animal'],
  ['2r', 2, 'ribbon'],
  ['3b', 3, 'bright'],
  ['3r', 3, 'ribbon'],
  ['4a', 4, 'animal'],
  ['4r', 4, 'ribbon'],
  ['5a', 5, 'animal'],
  ['5r', 5, 'ribbon'],
  ['6a', 6, 'animal'],
  ['6r', 6, 'ribbon'],
  ['7a', 7, 'animal'],
  ['7r', 7, 'ribbon'],
  ['8b', 8, 'bright'],
  ['8a', 8, 'animal'],
  ['9a', 9, 'animal'],
  ['9r', 9, 'ribbon'],
  ['10a', 10, 'animal'],
  ['10j', 10, 'junk']
]

const NAMED_HANDS = new Map<string, [number, string]>([
  ['1-2', [8, '알리']],
  ['1-4', [7, '독사']],
  ['1-9', [6, '구삥']],
  ['1-10', [5, '장삥']],
  ['4-10', [4, '장사']],
  ['4-6', [3, '세륙']]
])

export function createSeotdaDeck(): SeotdaCard[] {
  return CARD_SPECS.map(([id, month, kind]) => ({ id, month, kind }))
}

export function shuffleSeotdaDeck(random = Math.random): SeotdaCard[] {
  const deck = createSeotdaDeck()
  for (let index = deck.length - 1; index > 0; index--) {
    const swap = Math.floor(random() * (index + 1))
    ;[deck[index], deck[swap]] = [deck[swap]!, deck[index]!]
  }
  return deck
}

function monthKey(cards: readonly SeotdaCard[]): string {
  return cards
    .map((card) => card.month)
    .sort((left, right) => left - right)
    .join('-')
}

function hasIds(cards: readonly SeotdaCard[], first: string, second: string): boolean {
  const ids = new Set(cards.map((card) => card.id))
  return ids.has(first) && ids.has(second)
}

export function evaluateSeotdaHand(cards: readonly SeotdaCard[]): HandRank {
  if (cards.length !== 2) throw new Error('a Seotda hand must contain two cards')
  const key = monthKey(cards)
  if (hasIds(cards, '3b', '8b')) return { category: 12, tie: 3, name: '삼팔광땡' }
  if (hasIds(cards, '1b', '8b')) return { category: 12, tie: 2, name: '일팔광땡' }
  if (hasIds(cards, '1b', '3b')) return { category: 12, tie: 1, name: '일삼광땡' }

  if (cards[0]!.month === cards[1]!.month) {
    const month = cards[0]!.month
    return { category: 10, tie: month, name: month === 10 ? '장땡' : `${month}땡` }
  }

  if (hasIds(cards, '4a', '7a')) {
    return { category: 2, tie: 1, name: '암행어사', special: 'amhaeng' }
  }
  if (hasIds(cards, '3b', '7a')) {
    return { category: 2, tie: 0, name: '땡잡이', special: 'ddaengjabi' }
  }
  if (hasIds(cards, '4a', '9a')) {
    return { category: 2, tie: 3, name: '멍텅구리 구사', special: 'mungusa' }
  }
  if (key === '4-9') return { category: 2, tie: 3, name: '구사', special: 'gusa' }

  const named = NAMED_HANDS.get(key)
  if (named) return { category: 9, tie: named[0], name: named[1] }
  const point = (cards[0]!.month + cards[1]!.month) % 10
  return { category: 2, tie: point, name: point === 9 ? '갑오' : `${point}끗` }
}

function compareRanks(left: HandRank, right: HandRank): number {
  return left.category - right.category || left.tie - right.tie
}

export function resolveSeotdaHands(
  hands: Array<{ id: string; cards: readonly SeotdaCard[] }>
): { type: 'win'; winners: string[]; name: string } | { type: 'redeal'; name: string } {
  return resolveHands(hands, true)
}

function resolveHands(
  hands: Array<{ id: string; cards: readonly SeotdaCard[] }>,
  allowRedeal: boolean
): { type: 'win'; winners: string[]; name: string } | { type: 'redeal'; name: string } {
  if (hands.length === 0) return { type: 'win', winners: [], name: '승자 없음' }
  const ranked = hands.map((hand) => ({ ...hand, rank: evaluateSeotdaHand(hand.cards) }))
  const strongest = ranked.reduce((best, entry) =>
    compareRanks(entry.rank, best.rank) > 0 ? entry : best
  )

  const mungusa = ranked.filter((entry) => entry.rank.special === 'mungusa')
  if (
    allowRedeal &&
    mungusa.length > 0 &&
    !(strongest.rank.category === 12 || strongest.rank.tie === 10)
  ) {
    return { type: 'redeal', name: '멍텅구리 구사' }
  }
  const gusa = ranked.filter((entry) => entry.rank.special === 'gusa')
  if (allowRedeal && gusa.length > 0 && strongest.rank.category < 10) {
    return { type: 'redeal', name: '구사' }
  }

  if (
    strongest.rank.category === 12 &&
    strongest.rank.tie < 3 &&
    ranked.some((entry) => entry.rank.special === 'amhaeng')
  ) {
    return {
      type: 'win',
      winners: ranked.filter((entry) => entry.rank.special === 'amhaeng').map((entry) => entry.id),
      name: '암행어사'
    }
  }
  if (
    strongest.rank.category === 10 &&
    strongest.rank.tie < 10 &&
    ranked.some((entry) => entry.rank.special === 'ddaengjabi')
  ) {
    return {
      type: 'win',
      winners: ranked
        .filter((entry) => entry.rank.special === 'ddaengjabi')
        .map((entry) => entry.id),
      name: '땡잡이'
    }
  }

  return {
    type: 'win',
    winners: ranked
      .filter((entry) => compareRanks(entry.rank, strongest.rank) === 0)
      .map((entry) => entry.id),
    name: strongest.rank.name
  }
}

function nextActionableIndex(state: SeotdaState, after: number): number {
  for (let offset = 1; offset <= state.players.length; offset++) {
    const index = (after + offset) % state.players.length
    const player = state.players[index]!
    if (!player.folded && player.chips > 0) return index
  }
  return -1
}

function activePlayers(state: SeotdaState): SeotdaPlayer[] {
  return state.players.filter((player) => !player.folded)
}

function isBettingRoundComplete(state: SeotdaState): boolean {
  const actionable = activePlayers(state).filter((player) => player.chips > 0)
  if (actionable.length <= 1) {
    return actionable.every(
      (player) => player.acted && player.roundContribution === state.currentBet
    )
  }
  return actionable.every((player) => player.acted && player.roundContribution === state.currentBet)
}

function pay(player: SeotdaPlayer, amount: number): number {
  const paid = Math.min(player.chips, Math.max(0, amount))
  player.chips -= paid
  player.roundContribution += paid
  player.totalContribution += paid
  return paid
}

function resetBettingRound(state: SeotdaState, now: number): void {
  state.round = 1
  state.currentBet = 0
  for (const player of state.players) {
    player.roundContribution = 0
    player.acted = player.folded || player.chips === 0
  }
  state.turnIndex = nextActionableIndex(state, state.dealerIndex)
  state.turnDeadline = now + SEOTDA_TURN_MS
}

function payoutPot(
  state: SeotdaState,
  amount: number,
  eligible: SeotdaPlayer[],
  winners: string[],
  payouts: Record<string, number>
): void {
  const ordered = state.players.filter(
    (player) => winners.includes(player.id) && eligible.some((entry) => entry.id === player.id)
  )
  if (ordered.length === 0) return
  const share = Math.floor(amount / ordered.length)
  let remainder = amount % ordered.length
  for (const player of ordered) {
    const won = share + (remainder > 0 ? 1 : 0)
    remainder--
    player.chips += won
    payouts[player.id] = (payouts[player.id] ?? 0) + won
  }
}

function buildSidePots(state: SeotdaState): Array<{ amount: number; eligible: SeotdaPlayer[] }> {
  const levels = [
    ...new Set(state.players.map((player) => player.totalContribution).filter(Boolean))
  ].sort((left, right) => left - right)
  const pots: Array<{ amount: number; eligible: SeotdaPlayer[] }> = []
  let previous = 0
  for (const level of levels) {
    const contributors = state.players.filter((player) => player.totalContribution >= level)
    const amount = (level - previous) * contributors.length
    let eligible = contributors.filter((player) => !player.folded)
    if (eligible.length === 0) {
      const live = activePlayers(state)
      const highestLiveContribution = Math.max(...live.map((player) => player.totalContribution))
      eligible = live.filter((player) => player.totalContribution === highestLiveContribution)
    }
    if (amount > 0) pots.push({ amount, eligible })
    previous = level
  }
  return pots
}

function finishLastPlayer(state: SeotdaState): void {
  const winner = activePlayers(state)[0]!
  const pot = state.players.reduce((sum, player) => sum + player.totalContribution, 0)
  winner.chips += pot
  state.phase = 'finished'
  state.result = {
    reason: 'last-player',
    payouts: { [winner.id]: pot },
    lines: [`<@${winner.id}>님이 마지막 생존자로 ${pot}칩을 받았습니다.`]
  }
}

function redeal(state: SeotdaState, deck: SeotdaCard[], now: number, reason: string): void {
  const contenders = activePlayers(state)
  contenders.forEach((player, index) => {
    player.hand = [deck[index * 2]!, deck[index * 2 + 1]!]
    player.roundContribution = 0
    player.acted = player.chips === 0
  })
  state.players.filter((player) => player.folded).forEach((player) => (player.hand = []))
  state.redeals++
  state.round = 0
  state.currentBet = 0
  state.turnIndex = nextActionableIndex(state, state.dealerIndex)
  state.turnDeadline = now + SEOTDA_TURN_MS
  state.result = {
    reason: 'showdown',
    payouts: {},
    lines: [`${reason}로 재경기를 시작합니다. 기존 팟은 유지됩니다.`]
  }
}

export function settleSeotda(state: SeotdaState, deck: SeotdaCard[], now: number): void {
  const pots = buildSidePots(state)
  const resolutions = pots.map((pot) => ({
    pot,
    resolution: resolveSeotdaHands(
      pot.eligible.map((player) => ({ id: player.id, cards: player.hand }))
    )
  }))
  const redealReason = resolutions.find((entry) => entry.resolution.type === 'redeal')
  if (redealReason && state.redeals < SEOTDA_MAX_REDEALS) {
    redeal(state, deck, now, redealReason.resolution.name)
    if (activePlayers(state).filter((player) => player.chips > 0).length < 2) {
      settleSeotda(state, shuffleSeotdaDeck(), now)
    }
    return
  }

  const payouts: Record<string, number> = {}
  const lines: string[] = []
  resolutions.forEach(({ pot, resolution }, index) => {
    const finalResolution =
      resolution.type === 'redeal'
        ? resolveHands(
            pot.eligible.map((player) => ({ id: player.id, cards: player.hand })),
            false
          )
        : resolution
    const winners = finalResolution.type === 'win' ? finalResolution.winners : []
    payoutPot(state, pot.amount, pot.eligible, winners, payouts)
    const names = state.players
      .filter((player) => winners.includes(player.id))
      .map((player) => `<@${player.id}>`)
      .join(', ')
    lines.push(`팟 ${index + 1} ${pot.amount}칩: ${names} (${finalResolution.name})`)
  })
  state.phase = 'finished'
  state.result = { reason: 'showdown', payouts, lines }
}

export function startSeotda(
  state: SeotdaState,
  deck: SeotdaCard[],
  now = Date.now()
): string | null {
  if (state.phase !== 'lobby') return '이미 시작했거나 종료된 게임입니다.'
  if (state.players.length < 2) return '게임은 2명 이상이어야 시작할 수 있습니다.'
  if (state.players.length > SEOTDA_MAX_PLAYERS || deck.length < state.players.length * 2) {
    return `20장 덱으로는 최대 ${SEOTDA_MAX_PLAYERS}명까지 플레이할 수 있습니다.`
  }
  state.players.forEach((player, index) => {
    player.hand = [deck[index * 2]!, deck[index * 2 + 1]!]
    player.folded = false
    player.roundContribution = 0
    player.totalContribution = 0
    player.acted = false
    pay(player, SEOTDA_ANTE)
    player.roundContribution = 0
  })
  state.phase = 'betting'
  state.round = 0
  state.currentBet = 0
  state.dealerIndex = 0
  state.turnIndex = nextActionableIndex(state, state.dealerIndex)
  state.turnDeadline = now + SEOTDA_TURN_MS
  state.updatedAt = now
  state.result = undefined
  state.revision++
  return null
}

export function applySeotdaAction(
  state: SeotdaState,
  userId: string,
  action: SeotdaBetAction,
  deck: SeotdaCard[],
  now = Date.now()
): string | null {
  if (state.phase !== 'betting') return '현재 베팅 중인 게임이 아닙니다.'
  const playerIndex = state.players.findIndex((player) => player.id === userId)
  if (playerIndex < 0) return '참가자만 게임을 조작할 수 있습니다.'
  if (playerIndex !== state.turnIndex) return '지금은 본인 차례가 아닙니다.'
  const player = state.players[playerIndex]!
  if (player.folded || player.chips === 0) return '이미 다이했거나 올인한 참가자입니다.'
  const owed = state.currentBet - player.roundContribution

  if (action === 'check') {
    if (owed !== 0) return '받아야 할 베팅이 있어 체크할 수 없습니다.'
    player.acted = true
  } else if (action === 'call') {
    if (owed === 0) return '받을 금액이 없습니다. 체크를 사용하세요.'
    pay(player, owed)
    player.acted = true
  } else if (action === 'raise') {
    if (player.chips < owed + SEOTDA_RAISE) {
      return '콜 후 10칩을 더 낼 칩이 부족합니다. 올인을 사용하세요.'
    }
    pay(player, owed + SEOTDA_RAISE)
    state.currentBet = player.roundContribution
    state.players.forEach(
      (entry) => (entry.acted = entry.id === player.id || entry.folded || entry.chips === 0)
    )
  } else if (action === 'allin') {
    if (player.chips <= 0) return '올인할 칩이 없습니다.'
    pay(player, player.chips)
    if (player.roundContribution > state.currentBet) {
      state.currentBet = player.roundContribution
      state.players.forEach(
        (entry) => (entry.acted = entry.id === player.id || entry.folded || entry.chips === 0)
      )
    } else {
      player.acted = true
    }
  } else {
    player.folded = true
    player.acted = true
  }

  if (activePlayers(state).length === 1) {
    finishLastPlayer(state)
  } else if (isBettingRoundComplete(state)) {
    if (state.round === 0 && activePlayers(state).filter((entry) => entry.chips > 0).length >= 2) {
      resetBettingRound(state, now)
    } else settleSeotda(state, deck, now)
  } else {
    state.turnIndex = nextActionableIndex(state, playerIndex)
    state.turnDeadline = now + SEOTDA_TURN_MS
  }
  state.updatedAt = now
  state.revision++
  return null
}

export function timeoutSeotdaTurn(
  state: SeotdaState,
  deck: SeotdaCard[],
  now = Date.now()
): string | null {
  if (state.phase !== 'betting') return '현재 베팅 중인 게임이 아닙니다.'
  if (now < state.turnDeadline) return '아직 차례 제한 시간이 지나지 않았습니다.'
  const current = state.players[state.turnIndex]
  if (!current) return '현재 차례를 확인할 수 없습니다.'
  return applySeotdaAction(state, current.id, 'fold', deck, now)
}

export function seotdaPot(state: SeotdaState): number {
  return state.players.reduce((sum, player) => sum + player.totalContribution, 0)
}
