import { join } from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import { ComponentType, InteractionResponseType, MessageFlags } from 'discord.js'
import {
  CHESS_ACTION_BUTTON_ID,
  CHESS_MOVE_SELECT_ID,
  CHESS_PIECE_SELECT_ID,
  subcommand as chess
} from '../commands/chess.js'
import { getStoredValue, setStoredValue } from '../helpers/kv-store.js'
import { isolateStoredValues } from '../helpers/kv-store-test.js'
import {
  autocompleteJSON,
  buttonJSON,
  commandJSON,
  dispatch,
  getCallback,
  makeSubcommands,
  selectJSON,
  type RawInteraction,
  type RestCall
} from './e2e.js'

const subs = makeSubcommands(chess)
const storePath = join(process.cwd(), '.tmp', 'chess.test.sqlite')

function otherUser() {
  return {
    id: '555555555555555555',
    username: 'otheruser',
    discriminator: '0',
    avatar: null,
    global_name: 'Other User'
  }
}

function collectCustomIds(components: unknown[]): string[] {
  const queue = [...components]
  const ids: string[] = []
  while (queue.length > 0) {
    const current = queue.shift()
    if (!current || typeof current !== 'object') continue
    const record = current as { components?: unknown[]; custom_id?: unknown }
    if (typeof record.custom_id === 'string') ids.push(record.custom_id)
    if (Array.isArray(record.components)) queue.push(...record.components)
  }
  return ids
}

function selectValues(components: unknown[], baseId: string): string[] {
  const queue = [...components]
  while (queue.length > 0) {
    const current = queue.shift()
    if (!current || typeof current !== 'object') continue
    const record = current as {
      components?: unknown[]
      custom_id?: unknown
      options?: Array<{ value?: unknown }>
    }
    if (
      typeof record.custom_id === 'string' &&
      record.custom_id.startsWith(`${baseId}:`) &&
      Array.isArray(record.options)
    ) {
      return record.options.flatMap((option) =>
        typeof option.value === 'string' ? [option.value] : []
      )
    }
    if (Array.isArray(record.components)) queue.push(...record.components)
  }
  return []
}

function componentsFrom(calls: RestCall[]): unknown[] {
  const body = getCallback(calls) as { data?: { components?: unknown[] } }
  return body.data?.components ?? []
}

function pngFromCalls(calls: RestCall[]): Buffer | null {
  const file = calls.flatMap((call) => call.files)[0]
  if (Buffer.isBuffer(file)) return file
  if (!file || typeof file !== 'object') return null
  const data = (file as { data?: unknown }).data
  return Buffer.isBuffer(data) ? data : null
}

function seededMoveComponents(token: string, value: string): unknown[] {
  return [
    {
      type: ComponentType.ActionRow,
      components: [
        {
          type: ComponentType.StringSelect,
          custom_id: `${CHESS_MOVE_SELECT_ID}:${token}`,
          options: [{ label: 'Legal move', value }]
        }
      ]
    }
  ]
}

async function startAndJoin() {
  const startCalls = await dispatch(commandJSON('chess'), subs)
  const startComponents = componentsFrom(startCalls)
  const joinId = collectCustomIds(startComponents).find((id) => id.endsWith(':join'))!
  const joinCalls = await dispatch(buttonJSON(startComponents, joinId, { user: otherUser() }), subs)
  return { startCalls, joinCalls, components: componentsFrom(joinCalls) }
}

async function playMove(
  components: unknown[],
  from: string,
  to: string,
  user?: RawInteraction['user'],
  promotion = '-'
) {
  const overrides = user ? { user } : {}
  const pieceCalls = await dispatch(
    selectJSON(components, CHESS_PIECE_SELECT_ID, from, overrides),
    subs
  )
  const pieceComponents = componentsFrom(pieceCalls)
  const moveValue = selectValues(pieceComponents, CHESS_MOVE_SELECT_ID).find((value) =>
    value.startsWith(`${from}:${to}:${promotion}:`)
  )
  if (!moveValue) throw new Error(`move option not found: ${from}-${to}-${promotion}`)
  const moveCalls = await dispatch(
    selectJSON(pieceComponents, CHESS_MOVE_SELECT_ID, moveValue, overrides),
    subs
  )
  return { pieceCalls, moveCalls, components: componentsFrom(moveCalls) }
}

describe('chess — command', () => {
  beforeEach(() => {
    isolateStoredValues(storePath)
  })

  it('starts a public open challenge with a rendered board', async () => {
    const calls = await dispatch(commandJSON('chess'), subs)
    const body = getCallback(calls) as {
      type: number
      data: { components: unknown[]; flags: number }
    }
    const rendered = JSON.stringify(body.data.components)

    expect(body.type).toBe(InteractionResponseType.ChannelMessageWithSource)
    expect(body.data.flags & MessageFlags.IsComponentsV2).toBeTruthy()
    expect(body.data.flags & MessageFlags.Ephemeral).toBeFalsy()
    expect(rendered).toContain('Open challenge')
    expect(rendered).toContain('Join as Black')
    expect(rendered).toContain(`"type":${ComponentType.MediaGallery}`)
    expect(rendered).toContain('attachment://')
    expect(pngFromCalls(calls)?.subarray(1, 4).toString('ascii')).toBe('PNG')
  })

  it('returns chess in autocomplete', async () => {
    const calls = await dispatch(autocompleteJSON('che'), subs)
    const body = getCallback(calls) as { data: { choices: Array<{ value: string }> } }

    expect(body.data.choices.some((choice) => choice.value === 'chess')).toBe(true)
  })

  it('joins, selects a piece, and makes a move without text input', async () => {
    const { startCalls, joinCalls, components } = await startAndJoin()
    const joined = JSON.stringify(components)
    expect(joined).toContain('Other User')
    expect(joined).toContain(CHESS_PIECE_SELECT_ID)

    const moved = await playMove(components, 'e2', 'e4')
    const body = getCallback(moved.moveCalls) as { type: number; data: { components: unknown[] } }
    const rendered = JSON.stringify(body.data.components)

    expect(body.type).toBe(InteractionResponseType.UpdateMessage)
    expect(rendered).toContain('Black to move')
    expect(rendered).toContain('Pawn e2 to e4')
    expect(rendered).toContain(CHESS_PIECE_SELECT_ID)
    expect(pngFromCalls(startCalls)).toEqual(pngFromCalls(joinCalls))
    expect(pngFromCalls(joinCalls)).not.toEqual(pngFromCalls(moved.moveCalls))
  })

  it('rejects a player who acts out of turn', async () => {
    const { components } = await startAndJoin()
    const calls = await dispatch(
      selectJSON(components, CHESS_PIECE_SELECT_ID, 'e7', { user: otherUser() }),
      subs
    )
    const body = getCallback(calls) as { type: number; data: { flags: number } }

    expect(body.type).toBe(InteractionResponseType.ChannelMessageWithSource)
    expect(body.data.flags & MessageFlags.Ephemeral).toBeTruthy()
    expect(JSON.stringify(body)).toContain("It's not your turn yet")
  })

  it('rejects a stale destination menu after the selected piece changes', async () => {
    const { components } = await startAndJoin()
    const firstSelection = await dispatch(selectJSON(components, CHESS_PIECE_SELECT_ID, 'e2'), subs)
    const firstSelectionComponents = componentsFrom(firstSelection)
    const staleMove = selectValues(firstSelectionComponents, CHESS_MOVE_SELECT_ID).find((value) =>
      value.startsWith('e2:e4:-:')
    )!

    await dispatch(selectJSON(components, CHESS_PIECE_SELECT_ID, 'g1'), subs)
    const staleCalls = await dispatch(
      selectJSON(firstSelectionComponents, CHESS_MOVE_SELECT_ID, staleMove),
      subs
    )
    const body = getCallback(staleCalls) as { type: number; data: { components: unknown[] } }

    expect(body.type).toBe(InteractionResponseType.UpdateMessage)
    expect(JSON.stringify(body.data.components)).toContain('selected Knight on **g1**')
  })

  it('does not let White join the same challenge as Black', async () => {
    const calls = await dispatch(commandJSON('chess'), subs)
    const components = componentsFrom(calls)
    const joinId = collectCustomIds(components).find((id) => id.endsWith(':join'))!
    const joinCalls = await dispatch(buttonJSON(components, joinId), subs)
    const body = getCallback(joinCalls) as { type: number; data: { flags: number } }

    expect(body.type).toBe(InteractionResponseType.ChannelMessageWithSource)
    expect(body.data.flags & MessageFlags.Ephemeral).toBeTruthy()
    expect(JSON.stringify(body)).toContain('cannot also join as Black')
  })

  it('finishes by resignation and removes move controls', async () => {
    const { components } = await startAndJoin()
    const resignId = collectCustomIds(components).find((id) => id.endsWith(':resign'))!
    const calls = await dispatch(buttonJSON(components, resignId), subs)
    const body = getCallback(calls) as { type: number; data: { components: unknown[] } }
    const rendered = JSON.stringify(body.data.components)

    expect(body.type).toBe(InteractionResponseType.UpdateMessage)
    expect(rendered).toContain('Other User wins by resignation')
    expect(rendered).not.toContain(CHESS_PIECE_SELECT_ID)
    expect(rendered).not.toContain(':resign')
    expect(getStoredValue(`__chess-state:${resignId.split(':')[1]}`)).toBeUndefined()
  })

  it("detects checkmate after Fool's Mate", async () => {
    const joined = await startAndJoin()
    let current = joined.components
    current = (await playMove(current, 'f2', 'f3')).components
    current = (await playMove(current, 'e7', 'e5', otherUser())).components
    current = (await playMove(current, 'g2', 'g4')).components
    current = (await playMove(current, 'd8', 'h4', otherUser())).components
    const rendered = JSON.stringify(current)

    expect(rendered).toContain('Checkmate')
    expect(rendered).toContain('Other User wins as Black')
    expect(rendered).not.toContain(CHESS_PIECE_SELECT_ID)
  })

  it('supports promotion as a destination choice', async () => {
    setStoredValue(
      '__chess-state:promotion',
      JSON.stringify({
        commandInput: 'chess',
        white: { id: '666666666666666666', name: 'Test User' },
        black: { id: otherUser().id, name: 'Other User' },
        moves: [
          { from: 'a2', to: 'a4' },
          { from: 'h7', to: 'h5' },
          { from: 'a4', to: 'a5' },
          { from: 'h5', to: 'h4' },
          { from: 'a5', to: 'a6' },
          { from: 'h4', to: 'h3' },
          { from: 'a6', to: 'b7' },
          { from: 'h3', to: 'g2' }
        ],
        selected: { square: 'b7', userId: '666666666666666666', page: 0 },
        updatedAt: Date.now()
      })
    )
    const components = seededMoveComponents('promotion', 'b7:a8:q:8')
    const calls = await dispatch(selectJSON(components, CHESS_MOVE_SELECT_ID, 'b7:a8:q:8'), subs)
    const body = getCallback(calls) as { type: number; data: { components: unknown[] } }

    expect(body.type).toBe(InteractionResponseType.UpdateMessage)
    expect(JSON.stringify(body.data.components)).toContain('promoting to queen')
  })

  it('replays castling rights and executes castling from a dropdown', async () => {
    setStoredValue(
      '__chess-state:castle',
      JSON.stringify({
        commandInput: 'chess',
        white: { id: '666666666666666666', name: 'Test User' },
        black: { id: otherUser().id, name: 'Other User' },
        moves: [
          { from: 'e2', to: 'e4' },
          { from: 'e7', to: 'e5' },
          { from: 'g1', to: 'f3' },
          { from: 'b8', to: 'c6' },
          { from: 'f1', to: 'e2' },
          { from: 'g8', to: 'f6' }
        ],
        selected: { square: 'e1', userId: '666666666666666666', page: 0 },
        updatedAt: Date.now()
      })
    )
    const calls = await dispatch(
      selectJSON(seededMoveComponents('castle', 'e1:g1:-:6'), CHESS_MOVE_SELECT_ID, 'e1:g1:-:6'),
      subs
    )

    expect(JSON.stringify(getCallback(calls))).toContain('Castle kingside')
  })

  it('replays and executes en passant from a dropdown', async () => {
    setStoredValue(
      '__chess-state:en-passant',
      JSON.stringify({
        commandInput: 'chess',
        white: { id: '666666666666666666', name: 'Test User' },
        black: { id: otherUser().id, name: 'Other User' },
        moves: [
          { from: 'e2', to: 'e4' },
          { from: 'a7', to: 'a6' },
          { from: 'e4', to: 'e5' },
          { from: 'd7', to: 'd5' }
        ],
        selected: { square: 'e5', userId: '666666666666666666', page: 0 },
        updatedAt: Date.now()
      })
    )
    const calls = await dispatch(
      selectJSON(
        seededMoveComponents('en-passant', 'e5:d6:-:4'),
        CHESS_MOVE_SELECT_ID,
        'e5:d6:-:4'
      ),
      subs
    )

    expect(JSON.stringify(getCallback(calls))).toContain('capturing pawn')
  })

  it('returns an ephemeral error for expired controls', async () => {
    const calls = await dispatch(buttonJSON([], `${CHESS_ACTION_BUTTON_ID}:missing:join`), subs)
    const body = getCallback(calls) as { type: number; data: { flags: number } }

    expect(body.type).toBe(InteractionResponseType.ChannelMessageWithSource)
    expect(body.data.flags & MessageFlags.Ephemeral).toBeTruthy()
    expect(JSON.stringify(body)).toContain('Game expired')
  })

  it('refreshes a persisted final result from stale controls', async () => {
    setStoredValue(
      '__chess-state:finished',
      JSON.stringify({
        commandInput: 'chess',
        white: { id: '666666666666666666', name: 'Test User' },
        black: { id: otherUser().id, name: 'Other User' },
        moves: [],
        result: { type: 'resigned', winner: 'b' },
        updatedAt: Date.now()
      })
    )
    const components = [
      {
        type: ComponentType.ActionRow,
        components: [
          {
            type: ComponentType.Button,
            custom_id: `${CHESS_ACTION_BUTTON_ID}:finished:join`,
            label: 'Join as Black',
            style: 3
          }
        ]
      }
    ]
    const calls = await dispatch(
      buttonJSON(components, `${CHESS_ACTION_BUTTON_ID}:finished:join`),
      subs
    )
    const body = getCallback(calls) as { type: number; data: { components: unknown[] } }

    expect(body.type).toBe(InteractionResponseType.UpdateMessage)
    expect(JSON.stringify(body.data.components)).toContain('Other User wins by resignation')
    expect(getStoredValue('__chess-state:finished')).toBeUndefined()
  })
})
