import { beforeEach, describe, expect, it } from 'vitest'
import { InteractionResponseType, MessageFlags } from 'discord.js'
import { join } from 'node:path'
import { subcommand as get } from '../commands/get.js'
import { clearStoredValues, setStoredValue } from '../helpers/kv-store.js'
import { isolateStoredValues } from '../helpers/kv-store-test.js'
import { autocompleteJSON, commandJSON, dispatch, getCallback, makeSubcommands } from './e2e.js'

const subs = makeSubcommands(get)
const storePath = join(process.cwd(), '.tmp', 'get.test.sqlite')

describe('get — command', () => {
  beforeEach(() => {
    isolateStoredValues(storePath)
    clearStoredValues()
  })

  it('reads a stored value and replies immediately', async () => {
    setStoredValue('a', 'b')

    const calls = await dispatch(commandJSON('get a'), subs)
    const body = getCallback(calls) as { type: number; data: { flags: number } }

    expect(body.type).toBe(InteractionResponseType.ChannelMessageWithSource)
    expect(body.data.flags & MessageFlags.Ephemeral).toBeTruthy()
    expect(JSON.stringify(body)).toContain('a=b')
  })

  it('returns a missing message when the key is absent', async () => {
    const calls = await dispatch(commandJSON('get a'), subs)
    const body = getCallback(calls)

    expect(JSON.stringify(body)).toContain('no a')
  })

  it('replies publicly when --pub is set', async () => {
    setStoredValue('a', 'b')

    const calls = await dispatch(commandJSON('get a --pub'), subs)
    const body = getCallback(calls) as { type: number; data: { flags: number } }

    expect(body.type).toBe(InteractionResponseType.ChannelMessageWithSource)
    expect(body.data.flags & MessageFlags.Ephemeral).toBeFalsy()
  })
})

describe('get — autocomplete (selection mode)', () => {
  it('returns get as a choice when partially typed', async () => {
    const calls = await dispatch(autocompleteJSON('ge'), subs)
    const body = getCallback(calls) as { type: number; data: { choices: { value: string }[] } }

    expect(body.type).toBe(InteractionResponseType.ApplicationCommandAutocompleteResult)
    expect(body.data.choices.some((c) => c.value === 'get')).toBe(true)
  })
})
