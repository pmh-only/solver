import { beforeEach, describe, expect, it } from 'vitest'
import { InteractionResponseType } from 'discord.js'
import { subcommand as ping } from '../../../features/utilities/network/ping.js'
import { subcommand as math } from '../../../features/utilities/math/command.js'
import { subcommand as set } from '../../../features/utilities/storage/set.js'
import { subcommand as get } from '../../../features/utilities/storage/get.js'
import { clearStoredValues } from '../../../shared/storage/kv-store.js'
import {
  autocompleteJSON,
  commandJSON,
  dispatch,
  getCallback,
  makeSubcommands
} from '../../support/e2e.js'

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
    expect(JSON.stringify(body)).toContain('b')
  })

  it('still returns normal autocomplete matches', async () => {
    const calls = await dispatch(autocompleteJSON('ma'), subs)
    const body = getCallback(calls) as { data: { choices: { value: string }[] } }

    expect(body.data.choices.some((choice) => choice.value === 'math')).toBe(true)
  })
})
