import { beforeEach, describe, expect, it } from 'vitest'
import { InteractionResponseType, MessageFlags } from 'discord.js'
import { join } from 'node:path'
import { CONFIG_ENV_KEYS, subcommand as set } from '../commands/set.js'
import { clearStoredValues, getStoredValue, setStoredValue } from '../helpers/kv-store.js'
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

  it.each(CONFIG_ENV_KEYS)(
    'updates the %s environment configuration without persisting it',
    async (key) => {
      const previous = process.env[key]

      try {
        const calls = await dispatch(commandJSON(`set ${key} sensitive-value`), subs)
        const response = JSON.stringify(getCallback(calls))

        expect(process.env[key]).toBe('sensitive-value')
        expect(getStoredValue(key)).toBeUndefined()
        expect(response).toContain(`ok ${key}=[redacted]`)
        expect(response).not.toContain('sensitive-value')
      } finally {
        if (previous === undefined) delete process.env[key]
        else process.env[key] = previous
      }
    }
  )

  it('does not overwrite internal state keys', async () => {
    setStoredValue('__chess-state:token', 'original')

    const calls = await dispatch(commandJSON('set __chess-state:token replaced'), subs)

    expect(getStoredValue('__chess-state:token')).toBe('original')
    expect(JSON.stringify(getCallback(calls))).toContain('reserved key')
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
