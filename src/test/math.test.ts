import { describe, it, expect } from 'vitest'
import { InteractionResponseType, MessageFlags } from 'discord.js'
import { subcommand as math } from '../commands/math.js'
import { evaluateMath, evaluateMathString } from '../commands/math_core.js'
import { autocompleteJSON, commandJSON, dispatch, getCallback, makeSubcommands } from './e2e.js'

const subs = makeSubcommands(math)

describe('math — helpers', () => {
  it('evaluates arithmetic and function expressions', () => {
    expect(evaluateMath('1+1')).toBe(2)
    expect(evaluateMathString('cos(1)*pi')).toBe(
      String(Number((Math.cos(1) * Math.PI).toPrecision(15)))
    )
  })

  it('supports constants, unary operators, and precedence', () => {
    expect(evaluateMath('-(2^3)+pi')).toBeCloseTo(-(2 ** 3) + Math.PI)
    expect(evaluateMath('min(3, 1, 2) + max(4, 6)')).toBe(7)
  })
})

describe('math — command', () => {
  it('replies immediately for expressions', async () => {
    const calls = await dispatch(commandJSON('math 1+1'), subs)
    const body = getCallback(calls) as { type: number; data: { flags: number } }

    expect(body.type).toBe(InteractionResponseType.ChannelMessageWithSource)
    expect(body.data.flags & MessageFlags.Ephemeral).toBeTruthy()
    expect(JSON.stringify(body)).toContain('2')
  })

  it('replies publicly when --pub is set', async () => {
    const calls = await dispatch(commandJSON('math cos(1)*pi --pub'), subs)
    const body = getCallback(calls) as { type: number; data: { flags: number } }

    expect(body.type).toBe(InteractionResponseType.ChannelMessageWithSource)
    expect(body.data.flags & MessageFlags.Ephemeral).toBeFalsy()
    expect(JSON.stringify(body)).toContain(String(Number((Math.cos(1) * Math.PI).toPrecision(15))))
  })
})

describe('math — autocomplete', () => {
  it('returns math in selection mode', async () => {
    const calls = await dispatch(autocompleteJSON('ma'), subs)
    const body = getCallback(calls) as { type: number; data: { choices: { value: string }[] } }

    expect(body.type).toBe(InteractionResponseType.ApplicationCommandAutocompleteResult)
    expect(body.data.choices.some((choice) => choice.value === 'math')).toBe(true)
  })
})
