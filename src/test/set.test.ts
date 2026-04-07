import { beforeEach, describe, expect, it } from 'vitest'
import { InteractionResponseType, MessageFlags } from 'discord.js'
import { join } from 'node:path'
import { subcommand as set } from '../commands/set.js'
import { getStoredValue, clearStoredValues } from '../helpers/kv-store.js'
import { isolateStoredValues, reopenStoredValuesForTests } from '../helpers/kv-store-test.js'
import { autocompleteJSON, commandJSON, dispatch, getCallback, makeSubcommands } from './e2e.js'

const subs = makeSubcommands(set)
const storePath = join(process.cwd(), '.tmp', 'set.test.sqlite')

describe('set — command', () => {
  beforeEach(() => {
    isolateStoredValues(storePath)
    clearStoredValues()
  })

  it('stores a key/value pair and replies immediately', async () => {
    const calls = await dispatch(commandJSON('set a b'), subs)
    const body = getCallback(calls) as { type: number; data: { flags: number } }

    expect(body.type).toBe(InteractionResponseType.ChannelMessageWithSource)
    expect(body.data.flags & MessageFlags.Ephemeral).toBeTruthy()
    expect(getStoredValue('a')).toBe('b')
    expect(JSON.stringify(body)).toContain('ok a=b')
  })

  it('stores the full remaining text as the value', async () => {
    await dispatch(commandJSON('set aaaa hello world'), subs)

    expect(getStoredValue('aaaa')).toBe('hello world')
  })

  it('replies publicly when --pub is set', async () => {
    const calls = await dispatch(commandJSON('set a b --pub'), subs)
    const body = getCallback(calls) as { type: number; data: { flags: number } }

    expect(body.type).toBe(InteractionResponseType.ChannelMessageWithSource)
    expect(body.data.flags & MessageFlags.Ephemeral).toBeFalsy()
  })

  it('persists values across store reconnects', async () => {
    await dispatch(commandJSON('set keep value'), subs)

    reopenStoredValuesForTests()

    expect(getStoredValue('keep')).toBe('value')
  })
})

describe('set — autocomplete (selection mode)', () => {
  it('returns set as a choice when partially typed', async () => {
    const calls = await dispatch(autocompleteJSON('se'), subs)
    const body = getCallback(calls) as { type: number; data: { choices: { value: string }[] } }

    expect(body.type).toBe(InteractionResponseType.ApplicationCommandAutocompleteResult)
    expect(body.data.choices.some((c) => c.value === 'set')).toBe(true)
  })
})
