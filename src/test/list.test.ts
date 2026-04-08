import { beforeEach, describe, expect, it } from 'vitest'
import { InteractionResponseType, MessageFlags } from 'discord.js'
import { join } from 'node:path'
import { subcommand as list } from '../commands/list.js'
import { clearStoredValues, setStoredValue } from '../helpers/kv-store.js'
import { isolateStoredValues } from '../helpers/kv-store-test.js'
import { commandJSON, dispatch, getCallback, makeSubcommands } from './e2e.js'

const subs = makeSubcommands(list)
const storePath = join(process.cwd(), '.tmp', 'list.test.sqlite')

describe('list — command', () => {
  beforeEach(() => {
    isolateStoredValues(storePath)
    clearStoredValues()
  })

  it('shows empty message when no keys exist', async () => {
    const calls = await dispatch(commandJSON('list'), subs)
    const body = getCallback(calls) as { type: number; data: { flags: number } }

    expect(body.type).toBe(InteractionResponseType.ChannelMessageWithSource)
    expect(body.data.flags & MessageFlags.Ephemeral).toBeTruthy()
    expect(JSON.stringify(body)).toContain('(empty)')
  })

  it('lists stored keys', async () => {
    setStoredValue('alpha', '1')
    setStoredValue('beta', '2')

    const calls = await dispatch(commandJSON('list'), subs)
    const body = getCallback(calls)
    const json = JSON.stringify(body)

    expect(json).toContain('alpha')
    expect(json).toContain('beta')
    expect(json).toContain('2 keys found')
  })

  it('lists a single key with singular label', async () => {
    setStoredValue('only', 'one')

    const calls = await dispatch(commandJSON('list'), subs)
    const body = getCallback(calls)

    expect(JSON.stringify(body)).toContain('1 key found')
  })

  it('replies publicly when --pub is set', async () => {
    setStoredValue('a', 'b')

    const calls = await dispatch(commandJSON('list --pub'), subs)
    const body = getCallback(calls) as { type: number; data: { flags: number } }

    expect(body.type).toBe(InteractionResponseType.ChannelMessageWithSource)
    expect(body.data.flags & MessageFlags.Ephemeral).toBeFalsy()
  })
})
