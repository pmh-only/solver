import { join } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { InteractionResponseType, MessageFlags } from 'discord.js'
import { DICE_GUESS_BUTTON_ID, subcommand as dice } from '../commands/dice.js'
import { COIN_GUESS_BUTTON_ID, subcommand as coin } from '../commands/coin.js'
import { SLOTS_SPIN_BUTTON_ID, subcommand as slots } from '../commands/slots.js'
import { TTT_MOVE_BUTTON_ID, subcommand as ttt } from '../commands/ttt.js'
import { HILO_GUESS_BUTTON_ID, subcommand as hilo } from '../commands/hilo.js'
import { QUIZ_ANSWER_BUTTON_ID, subcommand as quiz } from '../commands/quiz.js'
import { isolateStoredValues } from '../helpers/kv-store-test.js'
import { autocompleteJSON, buttonJSON, commandJSON, dispatch, getCallback, makeSubcommands } from './e2e.js'

const subs = makeSubcommands(coin, dice, slots, ttt, hilo, quiz)
const storePath = join(process.cwd(), '.tmp', 'games.test.sqlite')

function otherUser() {
  return {
    id: '555555555555555555',
    username: 'otheruser',
    discriminator: '0',
    avatar: null,
    global_name: 'Other User'
  }
}

function collectButtonIds(components: unknown[]): string[] {
  const queue: unknown[] = [...components]
  const ids: string[] = []

  while (queue.length > 0) {
    const current = queue.shift()
    if (!current || typeof current !== 'object') continue

    const record = current as { components?: unknown[]; custom_id?: unknown }
    if (typeof record.custom_id === 'string') {
      ids.push(record.custom_id)
    }

    if (Array.isArray(record.components)) {
      queue.push(...record.components)
    }
  }

  return ids
}

function buttonIdByIndex(components: unknown[], base: string, index: number): string {
  const ids = collectButtonIds(components)
  return (
    ids.find((id) => id === `${base}`) ??
    ids.find((id) => id.startsWith(`${base}:`) && id.endsWith(`:${index}`)) ??
    ids.find((id) => id.startsWith(`${base}:`)) ??
    `${base}`
  )
}

describe('coin — command', () => {
  beforeEach(() => {
    isolateStoredValues(storePath)
  })

  it('starts a private flip game', async () => {
    const calls = await dispatch(commandJSON('coin'), subs)
    const body = getCallback(calls) as { type: number; data: { components: unknown[]; flags: number } }

    expect(body.type).toBe(InteractionResponseType.ChannelMessageWithSource)
    expect(body.data.flags & MessageFlags.Ephemeral).toBeTruthy()
    expect(body.data.flags & MessageFlags.IsComponentsV2).toBeTruthy()
    expect(JSON.stringify(body.data.components)).toContain('Coin flip')
  })

  it('reveals the result after a guess', async () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.2)

    const firstCalls = await dispatch(commandJSON('coin'), subs)
    const firstBody = getCallback(firstCalls) as { data: { components: unknown[] } }

    const coinCalls = await dispatch(buttonJSON(firstBody.data.components, COIN_GUESS_BUTTON_ID, {}), subs)
    const body = getCallback(coinCalls) as { type: number; data: { components: unknown[] } }
    const rendered = JSON.stringify(body.data.components)

    expect(body.type).toBe(InteractionResponseType.UpdateMessage)
    expect(rendered).toContain('Coin landed on Heads')
    expect(rendered).toContain('You win.')

    vi.restoreAllMocks()
  })

  it('starts as public when --pub is set', async () => {
    const calls = await dispatch(commandJSON('coin --pub'), subs)
    const body = getCallback(calls) as { type: number; data: { flags: number } }

    expect(body.type).toBe(InteractionResponseType.ChannelMessageWithSource)
    expect(body.data.flags & MessageFlags.Ephemeral).toBeFalsy()
  })

  it('returns coin in autocomplete', async () => {
    const calls = await dispatch(autocompleteJSON('co'), subs)
    const body = getCallback(calls) as { type: number; data: { choices: { value: string }[] } }

    expect(body.type).toBe(InteractionResponseType.ApplicationCommandAutocompleteResult)
    expect(body.data.choices.some((choice) => choice.value === 'coin')).toBe(true)
  })
})

describe('dice — command', () => {
  beforeEach(() => {
    isolateStoredValues(storePath)
  })

  it('starts a private roll game', async () => {
    const calls = await dispatch(commandJSON('dice'), subs)
    const body = getCallback(calls) as { type: number; data: { components: unknown[]; flags: number } }

    expect(body.type).toBe(InteractionResponseType.ChannelMessageWithSource)
    expect(body.data.flags & MessageFlags.Ephemeral).toBeTruthy()
    expect(body.data.flags & MessageFlags.IsComponentsV2).toBeTruthy()
    expect(JSON.stringify(body.data.components)).toContain('Dice roll')
  })

  it('reveals the roll after selecting a guess', async () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.2)

    const firstCalls = await dispatch(commandJSON('dice'), subs)
    const firstBody = getCallback(firstCalls) as { data: { components: unknown[] } }

    const diceCalls = await dispatch(buttonJSON(firstBody.data.components, DICE_GUESS_BUTTON_ID), subs)
    const body = getCallback(diceCalls) as { type: number; data: { components: unknown[] } }
    const rendered = JSON.stringify(body.data.components)

    expect(body.type).toBe(InteractionResponseType.UpdateMessage)
    expect(rendered).toContain('The die rolled')
    expect(rendered).toContain('You lose.')

    vi.restoreAllMocks()
  })

  it('starts as public when --pub is set', async () => {
    const calls = await dispatch(commandJSON('dice --pub'), subs)
    const body = getCallback(calls) as { type: number; data: { flags: number } }

    expect(body.type).toBe(InteractionResponseType.ChannelMessageWithSource)
    expect(body.data.flags & MessageFlags.Ephemeral).toBeFalsy()
  })

  it('returns dice in autocomplete', async () => {
    const calls = await dispatch(autocompleteJSON('di'), subs)
    const body = getCallback(calls) as { type: number; data: { choices: { value: string }[] } }

    expect(body.type).toBe(InteractionResponseType.ApplicationCommandAutocompleteResult)
    expect(body.data.choices.some((choice) => choice.value === 'dice')).toBe(true)
  })
})

describe('slots — command', () => {
  beforeEach(() => {
    isolateStoredValues(storePath)
  })

  it('starts a private slot machine', async () => {
    const calls = await dispatch(commandJSON('slots'), subs)
    const body = getCallback(calls) as { type: number; data: { components: unknown[]; flags: number } }

    expect(body.type).toBe(InteractionResponseType.ChannelMessageWithSource)
    expect(body.data.flags & MessageFlags.Ephemeral).toBeTruthy()
    expect(body.data.flags & MessageFlags.IsComponentsV2).toBeTruthy()
    expect(JSON.stringify(body.data.components)).toContain('Slot machine')
  })

  it('spins and renders symbols', async () => {
    vi.spyOn(Math, 'random').mockReturnValue(0)

    const firstCalls = await dispatch(commandJSON('slots'), subs)
    const firstBody = getCallback(firstCalls) as { data: { components: unknown[] } }

    const spinCalls = await dispatch(buttonJSON(firstBody.data.components, SLOTS_SPIN_BUTTON_ID), subs)
    const body = getCallback(spinCalls) as { type: number; data: { components: unknown[] } }
    const rendered = JSON.stringify(body.data.components)

    expect(body.type).toBe(InteractionResponseType.UpdateMessage)
    expect(rendered).toContain('🎰')
    expect(rendered).toContain('🍒')
    expect(rendered).toContain('Jackpot')

    vi.restoreAllMocks()
  })

  it('starts as public when --pub is set', async () => {
    const calls = await dispatch(commandJSON('slots --pub'), subs)
    const body = getCallback(calls) as { type: number; data: { flags: number } }

    expect(body.type).toBe(InteractionResponseType.ChannelMessageWithSource)
    expect(body.data.flags & MessageFlags.Ephemeral).toBeFalsy()
  })

  it('returns slots in autocomplete', async () => {
    const calls = await dispatch(autocompleteJSON('sl'), subs)
    const body = getCallback(calls) as { type: number; data: { choices: { value: string }[] } }

    expect(body.type).toBe(InteractionResponseType.ApplicationCommandAutocompleteResult)
    expect(body.data.choices.some((choice) => choice.value === 'slots')).toBe(true)
  })
})

describe('hilo — command', () => {
  beforeEach(() => {
    isolateStoredValues(storePath)
  })

  it('starts a private prediction game', async () => {
    const calls = await dispatch(commandJSON('hilo'), subs)
    const body = getCallback(calls) as { type: number; data: { components: unknown[]; flags: number } }

    expect(body.type).toBe(InteractionResponseType.ChannelMessageWithSource)
    expect(body.data.flags & MessageFlags.Ephemeral).toBeTruthy()
    expect(body.data.flags & MessageFlags.IsComponentsV2).toBeTruthy()
    expect(JSON.stringify(body.data.components)).toContain('High-Low')
  })

  it('reveals if the prediction was right', async () => {
    vi.spyOn(Math, 'random')
      .mockReturnValueOnce(0.1)
      .mockReturnValueOnce(0.9)

    const firstCalls = await dispatch(commandJSON('hilo'), subs)
    const firstBody = getCallback(firstCalls) as { data: { components: unknown[] } }

    const firstButton = buttonIdByIndex(firstBody.data.components, HILO_GUESS_BUTTON_ID, 0)
    const hiloCalls = await dispatch(buttonJSON(firstBody.data.components, firstButton), subs)
    const body = getCallback(hiloCalls) as { type: number; data: { components: unknown[] } }
    const rendered = JSON.stringify(body.data.components)

    expect(body.type).toBe(InteractionResponseType.UpdateMessage)
    expect(rendered).toContain('The next number was')
    expect(rendered.includes('You win.') || rendered.includes('You lose.')).toBe(true)

    vi.restoreAllMocks()
  })

  it('starts as public when --pub is set', async () => {
    const calls = await dispatch(commandJSON('hilo --pub'), subs)
    const body = getCallback(calls) as { type: number; data: { flags: number } }

    expect(body.type).toBe(InteractionResponseType.ChannelMessageWithSource)
    expect(body.data.flags & MessageFlags.Ephemeral).toBeFalsy()
  })

  it('returns hilo in autocomplete', async () => {
    const calls = await dispatch(autocompleteJSON('hi'), subs)
    const body = getCallback(calls) as { type: number; data: { choices: { value: string }[] } }

    expect(body.type).toBe(InteractionResponseType.ApplicationCommandAutocompleteResult)
    expect(body.data.choices.some((choice) => choice.value === 'hilo')).toBe(true)
  })
})

describe('quiz — command', () => {
  beforeEach(() => {
    isolateStoredValues(storePath)
  })

  it('starts a private quiz round', async () => {
    const calls = await dispatch(commandJSON('quiz'), subs)
    const body = getCallback(calls) as { type: number; data: { components: unknown[]; flags: number } }

    expect(body.type).toBe(InteractionResponseType.ChannelMessageWithSource)
    expect(body.data.flags & MessageFlags.Ephemeral).toBeTruthy()
    expect(body.data.flags & MessageFlags.IsComponentsV2).toBeTruthy()
    expect(JSON.stringify(body.data.components)).toContain('Quiz')
  })

  it('reveals whether the selected answer is correct', async () => {
    vi.spyOn(Math, 'random').mockReturnValue(0)

    const firstCalls = await dispatch(commandJSON('quiz'), subs)
    const firstBody = getCallback(firstCalls) as { data: { components: unknown[] } }

    const correctButton = buttonIdByIndex(firstBody.data.components, QUIZ_ANSWER_BUTTON_ID, 2)
    const quizCalls = await dispatch(buttonJSON(firstBody.data.components, correctButton), subs)
    const body = getCallback(quizCalls) as { type: number; data: { components: unknown[] } }
    const rendered = JSON.stringify(body.data.components)

    expect(body.type).toBe(InteractionResponseType.UpdateMessage)
    expect(rendered).toContain('Correct answer:')
    expect(rendered).toContain('Correct!')

    vi.restoreAllMocks()
  })

  it('starts as public when --pub is set', async () => {
    const calls = await dispatch(commandJSON('quiz --pub'), subs)
    const body = getCallback(calls) as { type: number; data: { flags: number } }

    expect(body.type).toBe(InteractionResponseType.ChannelMessageWithSource)
    expect(body.data.flags & MessageFlags.Ephemeral).toBeFalsy()
  })

  it('returns quiz in autocomplete', async () => {
    const calls = await dispatch(autocompleteJSON('qu'), subs)
    const body = getCallback(calls) as { type: number; data: { choices: { value: string }[] } }

    expect(body.type).toBe(InteractionResponseType.ApplicationCommandAutocompleteResult)
    expect(body.data.choices.some((choice) => choice.value === 'quiz')).toBe(true)
  })
})

describe('ttt — command', () => {
  beforeEach(() => {
    isolateStoredValues(storePath)
  })

  it('starts in private mode by default', async () => {
    const calls = await dispatch(commandJSON('ttt'), subs)
    const body = getCallback(calls) as { type: number; data: { components: unknown[]; flags: number } }

    expect(body.type).toBe(InteractionResponseType.ChannelMessageWithSource)
    expect(body.data.flags & MessageFlags.Ephemeral).toBeTruthy()
    expect(body.data.flags & MessageFlags.IsComponentsV2).toBeTruthy()
    expect(JSON.stringify(body.data.components)).toContain('Tic tac toe')
  })

  it('handles a turn against PC and shows both marks', async () => {
    vi.spyOn(Math, 'random').mockReturnValueOnce(0.0)

    const firstCalls = await dispatch(commandJSON('ttt --pc'), subs)
    const firstBody = getCallback(firstCalls) as { data: { components: unknown[] } }

    const firstMove = buttonIdByIndex(firstBody.data.components, TTT_MOVE_BUTTON_ID, 0)
    const secondCalls = await dispatch(buttonJSON(firstBody.data.components, firstMove), subs)
    const body = getCallback(secondCalls) as { type: number; data: { components: unknown[] } }
    const rendered = JSON.stringify(body.data.components)

    expect(body.type).toBe(InteractionResponseType.UpdateMessage)
    expect(rendered).toContain('❌')
    expect(rendered).toContain('⭕')

    vi.restoreAllMocks()
  })

  it('enforces turn order before allowing a third player', async () => {
    const firstCalls = await dispatch(commandJSON('ttt'), subs)
    const firstBody = getCallback(firstCalls) as { data: { components: unknown[] } }

    const topLeft = buttonIdByIndex(firstBody.data.components, TTT_MOVE_BUTTON_ID, 0)
    const firstMoveCalls = await dispatch(buttonJSON(firstBody.data.components, topLeft), subs)
    const firstMoveBody = getCallback(firstMoveCalls) as { type: number; data: { components: unknown[] } }

    const selfMoveCalls = await dispatch(
      buttonJSON(firstMoveBody.data.components, buttonIdByIndex(firstMoveBody.data.components, TTT_MOVE_BUTTON_ID, 1)),
      subs
    )
    const selfMoveBody = getCallback(selfMoveCalls) as { type: number; data: { flags: number } }

    expect(selfMoveBody.type).toBe(InteractionResponseType.ChannelMessageWithSource)
    expect(selfMoveBody.data.flags & MessageFlags.Ephemeral).toBeTruthy()

    const secondMoveCalls = await dispatch(
      buttonJSON(
        firstMoveBody.data.components,
        buttonIdByIndex(firstMoveBody.data.components, TTT_MOVE_BUTTON_ID, 1),
        {
          user: otherUser()
        }
      ),
      subs
    )
    const secondBody = getCallback(secondMoveCalls) as { type: number; data: { components: unknown[] } }

    expect(secondBody.type).toBe(InteractionResponseType.UpdateMessage)
    expect(JSON.stringify(secondBody.data.components)).toContain('⭕')
  })

  it('returns ttt in autocomplete', async () => {
    const calls = await dispatch(autocompleteJSON('tt'), subs)
    const body = getCallback(calls) as { type: number; data: { choices: { value: string }[] } }

    expect(body.type).toBe(InteractionResponseType.ApplicationCommandAutocompleteResult)
    expect(body.data.choices.some((choice) => choice.value === 'ttt')).toBe(true)
  })
})
