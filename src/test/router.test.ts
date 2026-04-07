import { beforeEach, describe, expect, it } from 'vitest'
import { InteractionResponseType } from 'discord.js'
import { subcommand as ping } from '../commands/ping.js'
import { subcommand as math } from '../commands/math.js'
import { subcommand as set } from '../commands/set.js'
import { subcommand as get } from '../commands/get.js'
import { clearStoredValues } from '../helpers/kv-store.js'
import { autocompleteJSON, commandJSON, dispatch, getCallback, makeSubcommands } from './e2e.js'

const subs = makeSubcommands(ping, math, set, get)

describe('router fallbacks', () => {
  beforeEach(() => {
    clearStoredValues()
  })

  it('treats bare math expressions as math input', async () => {
    const calls = await dispatch(commandJSON('1+1'), subs)
    const body = getCallback(calls) as { type: number }

    expect(body.type).toBe(InteractionResponseType.ChannelMessageWithSource)
    expect(JSON.stringify(body)).toContain('2')
  })

  it('treats a bare token as a stored value lookup', async () => {
    await dispatch(commandJSON('set a b'), subs)

    const calls = await dispatch(commandJSON('a'), subs)
    const body = getCallback(calls) as { type: number }

    expect(body.type).toBe(InteractionResponseType.ChannelMessageWithSource)
    expect(JSON.stringify(body)).toContain('a=b')
  })

  it('still returns normal autocomplete matches', async () => {
    const calls = await dispatch(autocompleteJSON('ma'), subs)
    const body = getCallback(calls) as { data: { choices: { value: string }[] } }

    expect(body.data.choices.some((choice) => choice.value === 'math')).toBe(true)
  })
})
