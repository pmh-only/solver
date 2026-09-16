import { join } from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import { InteractionResponseType, MessageFlags } from 'discord.js'
import {
  applySeotdaAction,
  createSeotdaDeck,
  evaluateSeotdaHand,
  resolveSeotdaHands,
  SEOTDA_MAX_REDEALS,
  settleSeotda,
  startSeotda,
  type SeotdaCard,
  type SeotdaPlayer,
  type SeotdaState
} from '../commands/seotda-runtime.js'
import { SEOTDA_BUTTON_ID, subcommand as seotda } from '../commands/seotda.js'
import {
  getStoredValue,
  releaseStoredLease,
  setStoredValue,
  tryAcquireStoredLease
} from '../helpers/kv-store.js'
import { isolateStoredValues } from '../helpers/kv-store-test.js'
import {
  buttonJSON,
  commandJSON,
  dispatch,
  getCallback,
  makeSubcommands,
  type RawInteraction,
  type RestCall
} from './e2e.js'

const storePath = join(process.cwd(), '.tmp', 'seotda.test.sqlite')
const subs = makeSubcommands(seotda)

function card(id: string): SeotdaCard {
  return createSeotdaDeck().find((entry) => entry.id === id)!
}

function player(id: string, hand: SeotdaCard[] = []): SeotdaPlayer {
  return {
    id,
    name: `Player ${id}`,
    chips: 100,
    hand,
    folded: false,
    roundContribution: 0,
    totalContribution: 0,
    acted: false
  }
}

function state(players = [player('a'), player('b')]): SeotdaState {
  return {
    hostId: players[0]!.id,
    channelId: '777777777777777777',
    phase: 'lobby',
    players,
    round: 0,
    turnIndex: 0,
    dealerIndex: 0,
    currentBet: 0,
    revision: 0,
    redeals: 0,
    turnDeadline: 0,
    updatedAt: 0
  }
}

function otherUser() {
  return {
    id: '555555555555555555',
    username: 'otheruser',
    discriminator: '0',
    avatar: null,
    global_name: 'Other User'
  }
}

function componentsFrom(calls: RestCall[]): unknown[] {
  return (getCallback(calls) as { data?: { components?: unknown[] } }).data?.components ?? []
}

function customIds(components: unknown[]): string[] {
  const queue = [...components]
  const ids: string[] = []
  while (queue.length > 0) {
    const entry = queue.shift()
    if (!entry || typeof entry !== 'object') continue
    const value = entry as { custom_id?: unknown; components?: unknown[] }
    if (typeof value.custom_id === 'string') ids.push(value.custom_id)
    if (Array.isArray(value.components)) queue.push(...value.components)
  }
  return ids
}

function actionId(components: unknown[], action: string): string {
  return customIds(components).find((id) => id.split(':')[2] === action)!
}

function userOverride(user: ReturnType<typeof otherUser>): Partial<RawInteraction> {
  return { user }
}

async function startLobby() {
  const calls = await dispatch(commandJSON('seotda'), subs)
  return { calls, components: componentsFrom(calls) }
}

async function joinLobby(components: unknown[]) {
  const calls = await dispatch(
    buttonJSON(components, actionId(components, 'join'), userOverride(otherUser())),
    subs
  )
  return { calls, components: componentsFrom(calls) }
}

describe('Seotda rules and settlement', () => {
  it('orders standard hands and identifies all adopted special hands', () => {
    expect(evaluateSeotdaHand([card('3b'), card('8b')]).name).toBe('삼팔광땡')
    expect(evaluateSeotdaHand([card('10a'), card('10j')]).name).toBe('장땡')
    expect(evaluateSeotdaHand([card('1j'), card('2a')]).name).toBe('알리')
    expect(evaluateSeotdaHand([card('4a'), card('7a')]).special).toBe('amhaeng')
    expect(evaluateSeotdaHand([card('3b'), card('7a')]).special).toBe('ddaengjabi')
    expect(evaluateSeotdaHand([card('4a'), card('9a')]).special).toBe('mungusa')
    expect(evaluateSeotdaHand([card('4r'), card('9r')]).special).toBe('gusa')
  })

  it('applies contextual ambush inspector and pair catcher rules', () => {
    expect(
      resolveSeotdaHands([
        { id: 'gwang', cards: [card('1b'), card('8b')] },
        { id: 'amhaeng', cards: [card('4a'), card('7a')] }
      ])
    ).toEqual({ type: 'win', winners: ['amhaeng'], name: '암행어사' })
    expect(
      resolveSeotdaHands([
        { id: 'pair', cards: [card('9a'), card('9r')] },
        { id: 'catcher', cards: [card('3b'), card('7a')] }
      ])
    ).toEqual({ type: 'win', winners: ['catcher'], name: '땡잡이' })
    expect(
      resolveSeotdaHands([
        { id: '38', cards: [card('3b'), card('8b')] },
        { id: 'amhaeng', cards: [card('4a'), card('7a')] }
      ])
    ).toEqual({ type: 'win', winners: ['38'], name: '삼팔광땡' })
  })

  it('forces adopted gusa redeals only under their documented thresholds', () => {
    expect(
      resolveSeotdaHands([
        { id: 'gusa', cards: [card('4r'), card('9r')] },
        { id: 'ali', cards: [card('1j'), card('2a')] }
      ])
    ).toEqual({ type: 'redeal', name: '구사' })
    expect(
      resolveSeotdaHands([
        { id: 'mungusa', cards: [card('4a'), card('9a')] },
        { id: 'pair', cards: [card('8b'), card('8a')] }
      ])
    ).toEqual({ type: 'redeal', name: '멍텅구리 구사' })
    expect(
      resolveSeotdaHands([
        { id: 'mungusa', cards: [card('4a'), card('9a')] },
        { id: 'jang', cards: [card('10a'), card('10j')] }
      ])
    ).toEqual({ type: 'win', winners: ['jang'], name: '장땡' })
  })

  it('runs two betting rounds and conserves chips at showdown', () => {
    const game = state()
    const deck = [card('3b'), card('8b'), card('1b'), card('1j'), ...createSeotdaDeck()]
    expect(startSeotda(game, deck, 1)).toBeNull()
    expect(game.players.map((entry) => entry.chips)).toEqual([90, 90])
    expect(game.turnIndex).toBe(1)

    expect(applySeotdaAction(game, 'b', 'check', deck, 2)).toBeNull()
    expect(applySeotdaAction(game, 'a', 'check', deck, 3)).toBeNull()
    expect(game.round).toBe(1)
    expect(applySeotdaAction(game, 'b', 'check', deck, 4)).toBeNull()
    expect(applySeotdaAction(game, 'a', 'check', deck, 5)).toBeNull()

    expect(game.phase).toBe('finished')
    expect(game.players.find((entry) => entry.id === 'a')?.chips).toBe(110)
    expect(game.players.reduce((sum, entry) => sum + entry.chips, 0)).toBe(200)
  })

  it('enforces the deck maximum and rejects an underfunded fixed raise without mutation', () => {
    const tooMany = state(Array.from({ length: 11 }, (_, index) => player(String(index))))
    expect(startSeotda(tooMany, createSeotdaDeck(), 1)).toContain('최대 10명')

    const game = state()
    game.phase = 'betting'
    game.turnIndex = 0
    game.currentBet = 20
    game.players[0]!.chips = 25
    expect(applySeotdaAction(game, 'a', 'raise', createSeotdaDeck(), 1)).toContain(
      '칩이 부족합니다'
    )
    expect(game.players[0]!.chips).toBe(25)
    expect(game.players[0]!.totalContribution).toBe(0)
  })

  it('settles main and side pots independently and splits ties deterministically', () => {
    const sidePot = state([
      player('a', [card('1j'), card('2a')]),
      player('b', [card('3b'), card('8b')]),
      player('c', [card('5a'), card('6r')])
    ])
    sidePot.phase = 'betting'
    sidePot.players.forEach((entry) => (entry.chips = 0))
    sidePot.players[0]!.totalContribution = 100
    sidePot.players[1]!.totalContribution = 50
    sidePot.players[2]!.totalContribution = 100
    sidePot.players[2]!.folded = true
    settleSeotda(sidePot, createSeotdaDeck(), 1)
    expect(sidePot.result?.payouts).toEqual({ b: 150, a: 100 })
    expect(sidePot.players.reduce((sum, entry) => sum + entry.chips, 0)).toBe(250)

    const tied = state([
      player('a', [card('2a'), card('7r')]),
      player('b', [card('2r'), card('7a')]),
      player('c', [card('1j'), card('5a')])
    ])
    tied.phase = 'betting'
    tied.players.forEach((entry) => {
      entry.chips = 0
      entry.totalContribution = 1
    })
    tied.players[2]!.folded = true
    settleSeotda(tied, createSeotdaDeck(), 1)
    expect(tied.result?.payouts).toEqual({ a: 2, b: 1 })
  })

  it('auto-settles when all survivors are all-in without creating turn -1', () => {
    const game = state()
    const deck = [card('3b'), card('8b'), card('1b'), card('1j'), ...createSeotdaDeck()]
    startSeotda(game, deck, 1)
    expect(applySeotdaAction(game, 'b', 'allin', deck, 2)).toBeNull()
    expect(applySeotdaAction(game, 'a', 'allin', deck, 3)).toBeNull()
    expect(game.phase).toBe('finished')
    expect(game.players.reduce((sum, entry) => sum + entry.chips, 0)).toBe(200)
  })

  it('rolls a folded-only upper tier into the highest live pot without losing chips', () => {
    const game = state([
      player('a', [card('3b'), card('8b')]),
      player('b', [card('1b'), card('1j')]),
      player('c', [card('2a'), card('5a')]),
      player('d', [card('6a'), card('7a')])
    ])
    game.phase = 'betting'
    game.players.forEach((entry, index) => {
      entry.chips = 0
      entry.totalContribution = index < 2 ? 50 : 100
      entry.folded = index >= 2
    })
    settleSeotda(game, createSeotdaDeck(), 1)
    expect(Object.values(game.result!.payouts).reduce((sum, amount) => sum + amount, 0)).toBe(300)
    expect(game.players.reduce((sum, entry) => sum + entry.chips, 0)).toBe(300)
  })

  it('caps repeated special-hand redeals and still awards the pot', () => {
    const game = state([
      player('a', [card('4r'), card('9r')]),
      player('b', [card('1j'), card('2a')])
    ])
    game.phase = 'betting'
    game.redeals = SEOTDA_MAX_REDEALS
    game.players.forEach((entry) => {
      entry.chips = 90
      entry.totalContribution = 10
    })
    settleSeotda(game, createSeotdaDeck(), 1)
    expect(game.phase).toBe('finished')
    expect(Object.values(game.result!.payouts).reduce((sum, amount) => sum + amount, 0)).toBe(20)
  })

  it('keeps pair-catcher resolution when only capped redeal effects are ignored', () => {
    const game = state([
      player('gusa', [card('4a'), card('9a')]),
      player('pair', [card('8b'), card('8a')]),
      player('catcher', [card('3b'), card('7a')])
    ])
    game.phase = 'betting'
    game.redeals = SEOTDA_MAX_REDEALS
    game.players.forEach((entry) => {
      entry.chips = 90
      entry.totalContribution = 10
    })
    settleSeotda(game, createSeotdaDeck(), 1)
    expect(game.result?.payouts).toEqual({ catcher: 30 })
  })
})

describe('Seotda Discord interactions', () => {
  beforeEach(() => {
    isolateStoredValues(storePath)
  })

  it('creates a public Components V2 lobby with no top-level content or embeds', async () => {
    const { calls } = await startLobby()
    const body = getCallback(calls) as {
      type: number
      data: { content?: unknown; embeds?: unknown; components: unknown[]; flags: number }
    }
    expect(body.type).toBe(InteractionResponseType.ChannelMessageWithSource)
    expect(body.data.flags).toBe(MessageFlags.IsComponentsV2)
    expect(body.data.content).toBeUndefined()
    expect(body.data.embeds).toBeUndefined()
    expect(JSON.stringify(body.data.components)).toContain('섯다 로비')
    expect(JSON.stringify(body.data.components)).toContain('최대 10명')
  })

  it('allows lobby join but restricts start to the host', async () => {
    const lobby = await startLobby()
    const joined = await joinLobby(lobby.components)
    expect(JSON.stringify(joined.components)).toContain('Other User')

    const denied = await dispatch(
      buttonJSON(
        joined.components,
        actionId(joined.components, 'start'),
        userOverride(otherUser())
      ),
      subs
    )
    const deniedBody = getCallback(denied) as { type: number; data: { flags: number } }
    expect(deniedBody.type).toBe(InteractionResponseType.ChannelMessageWithSource)
    expect(deniedBody.data.flags & MessageFlags.Ephemeral).toBeTruthy()
    expect(JSON.stringify(deniedBody)).toContain('방장만')
  })

  it('transfers lobby ownership when the host leaves', async () => {
    const lobby = await startLobby()
    const joined = await joinLobby(lobby.components)
    const left = await dispatch(
      buttonJSON(joined.components, actionId(joined.components, 'leave')),
      subs
    )
    const rendered = JSON.stringify(componentsFrom(left))
    expect(rendered).toContain('Other User (방장)')
    expect(rendered).not.toContain('Test User (방장)')
  })

  it('starts once, hides all hands on the board, and shows only the requester private hand', async () => {
    const lobby = await startLobby()
    const joined = await joinLobby(lobby.components)
    const started = await dispatch(
      buttonJSON(joined.components, actionId(joined.components, 'start')),
      subs
    )
    const board = componentsFrom(started)
    const rendered = JSON.stringify(board)
    expect(rendered).toContain('1/2차 베팅')
    expect(rendered).not.toMatch(/월 (광|열끗|띠|피)/)

    const handCalls = await dispatch(buttonJSON(board, actionId(board, 'hand')), subs)
    const handBody = getCallback(handCalls) as { type: number; data: { flags: number } }
    expect(handBody.type).toBe(InteractionResponseType.ChannelMessageWithSource)
    expect(handBody.data.flags & MessageFlags.Ephemeral).toBeTruthy()
    expect(JSON.stringify(handBody)).toMatch(/월 (광|열끗|띠|피)/)

    const staleStart = await dispatch(buttonJSON(board, actionId(joined.components, 'start')), subs)
    expect((getCallback(staleStart) as { type: number }).type).toBe(
      InteractionResponseType.UpdateMessage
    )
    expect(JSON.stringify(getCallback(staleStart))).toContain('1/2차 베팅')
  })

  it('rejects nonparticipants and out-of-turn betting actions', async () => {
    const lobby = await startLobby()
    const joined = await joinLobby(lobby.components)
    const started = await dispatch(
      buttonJSON(joined.components, actionId(joined.components, 'start')),
      subs
    )
    const board = componentsFrom(started)
    const hostAction = await dispatch(buttonJSON(board, actionId(board, 'check')), subs)
    expect(JSON.stringify(getCallback(hostAction))).toContain('본인 차례가 아닙니다')

    const outsider = {
      id: '444444444444444444',
      username: 'outsider',
      discriminator: '0',
      avatar: null,
      global_name: 'Outsider'
    }
    const outsiderAction = await dispatch(
      buttonJSON(board, actionId(board, 'check'), { user: outsider }),
      subs
    )
    expect(JSON.stringify(getCallback(outsiderAction))).toContain('참가자만')
  })

  it('does not apply the same betting click twice', async () => {
    const lobby = await startLobby()
    const joined = await joinLobby(lobby.components)
    const started = await dispatch(
      buttonJSON(joined.components, actionId(joined.components, 'start')),
      subs
    )
    const board = componentsFrom(started)
    const checkId = actionId(board, 'check')
    await dispatch(buttonJSON(board, checkId, userOverride(otherUser())), subs)
    await dispatch(buttonJSON(board, checkId, userOverride(otherUser())), subs)

    const token = checkId.split(':')[1]!
    const stored = JSON.parse(getStoredValue(`__seotda-state:${token}`)!) as SeotdaState
    expect(stored.revision).toBe(3)
    expect(stored.turnIndex).toBe(0)
  })

  it('expires a stalled turn through a participant timeout action', async () => {
    const lobby = await startLobby()
    const joined = await joinLobby(lobby.components)
    const started = await dispatch(
      buttonJSON(joined.components, actionId(joined.components, 'start')),
      subs
    )
    const board = componentsFrom(started)
    const timeoutId = actionId(board, 'timeout')
    const token = timeoutId.split(':')[1]!
    const storedKey = `__seotda-state:${token}`
    const stored = JSON.parse(getStoredValue(storedKey)!) as SeotdaState
    stored.turnDeadline = 0
    setStoredValue(storedKey, JSON.stringify(stored))

    const timedOut = await dispatch(buttonJSON(board, timeoutId), subs)
    const body = getCallback(timedOut) as { type: number; data: { components: unknown[] } }
    expect(body.type).toBe(InteractionResponseType.UpdateMessage)
    expect(JSON.stringify(body.data.components)).toContain('마지막 생존자')
  })

  it('shows Korean adopted rules privately and rejects expired controls safely', async () => {
    const lobby = await startLobby()
    const rules = await dispatch(
      buttonJSON(lobby.components, actionId(lobby.components, 'help')),
      subs
    )
    const rulesBody = getCallback(rules) as { data: { flags: number } }
    const rendered = JSON.stringify(rulesBody)
    expect(rulesBody.data.flags & MessageFlags.Ephemeral).toBeTruthy()
    expect(rendered).toContain('암행어사')
    expect(rendered).toContain('사이드팟')
    expect(rendered).toContain('실제 결제')

    const expired = await dispatch(buttonJSON([], `${SEOTDA_BUTTON_ID}:missing:join:0`), subs)
    const expiredBody = getCallback(expired) as { data: { flags: number } }
    expect(expiredBody.data.flags & MessageFlags.Ephemeral).toBeTruthy()
    expect(JSON.stringify(expiredBody)).toContain('만료')
  })

  it('treats corrupt persisted state as expired', async () => {
    setStoredValue('__seotda-state:corrupt', '{not-json')
    const calls = await dispatch(buttonJSON([], `${SEOTDA_BUTTON_ID}:corrupt:join:0`), subs)
    expect(JSON.stringify(getCallback(calls))).toContain('만료')
    expect(getStoredValue('__seotda-state:corrupt')).toBeUndefined()
  })

  it('rejects structurally corrupt state and serializes mutations with a stored lease', async () => {
    const malformed = state()
    malformed.phase = 'betting'
    malformed.players[0]!.hand = [card('1b')]
    malformed.players[1]!.hand = [card('2a'), card('2r')]
    malformed.updatedAt = Date.now()
    setStoredValue('__seotda-state:malformed', JSON.stringify(malformed))
    const corruptCalls = await dispatch(
      buttonJSON([], `${SEOTDA_BUTTON_ID}:malformed:check:0`),
      subs
    )
    expect(JSON.stringify(getCallback(corruptCalls))).toContain('만료')

    const lobby = await startLobby()
    const joinId = actionId(lobby.components, 'join')
    const token = joinId.split(':')[1]!
    expect(tryAcquireStoredLease(`__seotda-lock:${token}`, 'other-worker', 10_000)).toBe(true)
    const blocked = await dispatch(
      buttonJSON(lobby.components, joinId, userOverride(otherUser())),
      subs
    )
    expect(JSON.stringify(getCallback(blocked))).toContain('다른 동작을 처리 중')
    releaseStoredLease(`__seotda-lock:${token}`, 'other-worker')
  })
})
