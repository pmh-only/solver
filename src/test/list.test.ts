import { beforeEach, describe, expect, it } from 'vitest'
import { InteractionResponseType, MessageFlags } from 'discord.js'
import { join } from 'node:path'
import { subcommand as list } from '../commands/list.js'
import {
  clearStoredValues,
  releaseStoredLease,
  setStoredValue,
  tryAcquireStoredLease
} from '../helpers/kv-store.js'
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

  it('hides namespaced keys from the default list', async () => {
    setStoredValue('alpha', '1')
    setStoredValue('chess:opening', 'Sicilian')
    setStoredValue('project:status', 'active')

    const calls = await dispatch(commandJSON('list'), subs)
    const json = JSON.stringify(getCallback(calls))

    expect(json).toContain('alpha')
    expect(json).toContain('1 key found')
    expect(json).not.toContain('chess:opening')
    expect(json).not.toContain('project:status')
  })

  it('lists only keys from the selected namespace', async () => {
    setStoredValue('alpha', '1')
    setStoredValue('project:status', 'active')
    setStoredValue('project:release:date', 'tomorrow')
    setStoredValue('other:status', 'inactive')

    const calls = await dispatch(commandJSON('list project'), subs)
    const json = JSON.stringify(getCallback(calls))

    expect(json).toContain('project:status')
    expect(json).toContain('project:release:date')
    expect(json).toContain('2 keys found')
    expect(json).not.toContain('alpha')
    expect(json).not.toContain('other:status')
  })

  it('hides system-generated keys', async () => {
    setStoredValue('alpha', '1')
    setStoredValue('command-input:token', 'list')
    setStoredValue('__chess-state:token', '{}')
    setStoredValue('__quiz-generation:session:token', '{}')
    setStoredValue('__quiz-state:token', '{}')
    setStoredValue('constrained-command:token', '{"command":"ping","args":"1.1.1.1"}')
    setStoredValue('gpt-ctx:token', '{"prompt":"hi"}')
    setStoredValue('gpt-mcp-servers', '[]')
    setStoredValue('gpt-settings:1:default', '{"model":"gpt-5.4"}')
    setStoredValue('gpt-session:1:default', '[]')
    setStoredValue('gpt-session-selected:1', 'default')
    setStoredValue('lyrics-offsets', '{"version":1,"tracks":{}}')
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
    expect(json).not.toContain('__quiz-generation:session:token')
    expect(json).not.toContain('__quiz-state:token')
    expect(json).not.toContain('constrained-command:token')
    expect(json).not.toContain('gpt-ctx:token')
    expect(json).not.toContain('gpt-mcp-servers')
    expect(json).not.toContain('gpt-settings:1:default')
    expect(json).not.toContain('gpt-session:1:default')
    expect(json).not.toContain('gpt-session-selected:1')
    expect(json).not.toContain('lyrics-offsets')
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

  it('shows ordinary chess-prefixed user keys when that namespace is selected', async () => {
    setStoredValue('chess:opening', 'Sicilian')

    const calls = await dispatch(commandJSON('list chess'), subs)

    expect(JSON.stringify(getCallback(calls))).toContain('chess:opening')
  })

  it('keeps a stored lease exclusive until its owner releases it', () => {
    const key = '__quiz-generation:session:test'
    expect(tryAcquireStoredLease(key, 'owner-1', 30_000, 1_000)).toBe(true)
    expect(tryAcquireStoredLease(key, 'owner-2', 30_000, 1_001)).toBe(false)

    releaseStoredLease(key, 'owner-2')
    expect(tryAcquireStoredLease(key, 'owner-2', 30_000, 1_002)).toBe(false)

    releaseStoredLease(key, 'owner-1')
    expect(tryAcquireStoredLease(key, 'owner-2', 30_000, 1_003)).toBe(true)
  })

  it('replies publicly when --pub is set', async () => {
    setStoredValue('a', 'b')

    const calls = await dispatch(commandJSON('list --pub'), subs)
    const body = getCallback(calls) as { type: number; data: { flags: number } }

    expect(body.type).toBe(InteractionResponseType.ChannelMessageWithSource)
    expect(body.data.flags & MessageFlags.Ephemeral).toBeFalsy()
  })
})
