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

  it('hides system-generated keys', async () => {
    setStoredValue('alpha', '1')
    setStoredValue('command-input:token', 'list')
    setStoredValue('__chess-state:token', '{}')
    setStoredValue('constrained-command:token', '{"command":"ping","args":"1.1.1.1"}')
    setStoredValue('gpt-ctx:token', '{"prompt":"hi"}')
    setStoredValue('message-input:0', 'ping 1.1.1.1')
    setStoredValue('message-render-collection:0:1', '{}')
    setStoredValue('message-store-pending:1', 'pending')
    setStoredValue('poll:token', '{}')
    setStoredValue('pub-content:token', 'published content')

    const calls = await dispatch(commandJSON('list'), subs)
    const body = getCallback(calls)
    const json = JSON.stringify(body)

    expect(json).toContain('alpha')
    expect(json).toContain('1 key found')
    expect(json).not.toContain('command-input:token')
    expect(json).not.toContain('__chess-state:token')
    expect(json).not.toContain('constrained-command:token')
    expect(json).not.toContain('gpt-ctx:token')
    expect(json).not.toContain('message-input:0')
    expect(json).not.toContain('message-render-collection:0:1')
    expect(json).not.toContain('message-store-pending:1')
    expect(json).not.toContain('poll:token')
    expect(json).not.toContain('pub-content:token')
  })

  it('lists a single key with singular label', async () => {
    setStoredValue('only', 'one')

    const calls = await dispatch(commandJSON('list'), subs)
    const body = getCallback(calls)

    expect(JSON.stringify(body)).toContain('1 key found')
  })

  it('keeps ordinary chess-prefixed user keys visible', async () => {
    setStoredValue('chess:opening', 'Sicilian')

    const calls = await dispatch(commandJSON('list'), subs)

    expect(JSON.stringify(getCallback(calls))).toContain('chess:opening')
  })

  it('replies publicly when --pub is set', async () => {
    setStoredValue('a', 'b')

    const calls = await dispatch(commandJSON('list --pub'), subs)
    const body = getCallback(calls) as { type: number; data: { flags: number } }

    expect(body.type).toBe(InteractionResponseType.ChannelMessageWithSource)
    expect(body.data.flags & MessageFlags.Ephemeral).toBeFalsy()
  })
})
