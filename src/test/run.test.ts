import { describe, it, expect } from 'vitest'
import { InteractionResponseType, MessageFlags } from 'discord.js'
import { subcommand as run } from '../commands/run.js'
import { autocompleteJSON, commandJSON, dispatch, getCallback, makeSubcommands } from './e2e.js'

const subs = makeSubcommands(run)

describe('run - command', () => {
  it('replies immediately with console output and result', async () => {
    const calls = await dispatch(commandJSON("run console.log('hello'); 1 + 1"), subs)
    const body = getCallback(calls) as {
      type: number
      data: { flags: number; components: unknown[] }
    }
    const text = JSON.stringify(body.data.components)

    expect(body.type).toBe(InteractionResponseType.ChannelMessageWithSource)
    expect(body.data.flags & MessageFlags.Ephemeral).toBeTruthy()
    expect(text.includes('hello')).toBe(true)
    expect(text.includes('2')).toBe(true)
  })

  it('returns vm timeout errors clearly', async () => {
    const calls = await dispatch(commandJSON('run while (true) {}'), subs)
    const body = getCallback(calls) as { data: { components: unknown[] } }
    const text = JSON.stringify(body.data.components)

    expect(text.includes('timeout')).toBe(true)
  })

  it('replies publicly with --pub', async () => {
    const calls = await dispatch(commandJSON('run 1 + 1 --pub'), subs)
    const body = getCallback(calls) as { type: number; data: { flags: number } }

    expect(body.type).toBe(InteractionResponseType.ChannelMessageWithSource)
    expect(body.data.flags & MessageFlags.Ephemeral).toBeFalsy()
  })
})

describe('run - autocomplete', () => {
  it('returns run in selection mode', async () => {
    const calls = await dispatch(autocompleteJSON('ru'), subs)
    const body = getCallback(calls) as { type: number; data: { choices: { value: string }[] } }

    expect(body.type).toBe(InteractionResponseType.ApplicationCommandAutocompleteResult)
    expect(body.data.choices.some((choice) => choice.value === 'run')).toBe(true)
  })
})
