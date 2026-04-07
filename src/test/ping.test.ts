import { describe, it, expect } from 'vitest'
import { InteractionResponseType, MessageFlags } from 'discord.js'
import { subcommand as ping } from '../commands/ping.js'
import { commandJSON, autocompleteJSON, dispatch, getCallback, getEdit, makeSubcommands } from './e2e.js'

const subs = makeSubcommands(ping)

describe('ping — command', () => {
  it('replies with pong when no host given', async () => {
    const calls = await dispatch(commandJSON('ping'), subs)
    const body = getCallback(calls) as { type: number; data: { flags: number } }

    expect(body.type).toBe(InteractionResponseType.ChannelMessageWithSource)
    expect(body.data.flags & MessageFlags.Ephemeral).toBeTruthy() // ephemeral by default
  })

  it('defers ephemerally then edits when host given as bare arg', async () => {
    const calls = await dispatch(commandJSON('ping 127.0.0.1'), subs)
    const defer = getCallback(calls) as { type: number; data: { flags: number } }
    const edit = getEdit(calls) as { components: unknown[] }

    expect(defer.type).toBe(InteractionResponseType.DeferredChannelMessageWithSource)
    expect(defer.data.flags & MessageFlags.Ephemeral).toBeTruthy()
    expect(edit.components).toBeDefined()
  })

  it('defers ephemerally then edits when host given via --ip flag', async () => {
    const calls = await dispatch(commandJSON('ping --ip 127.0.0.1'), subs)
    const defer = getCallback(calls) as { type: number; data: { flags: number } }
    const edit = getEdit(calls)

    expect(defer.type).toBe(InteractionResponseType.DeferredChannelMessageWithSource)
    expect(edit).not.toBeNull()
  })

  it('defers publicly when --pub flag set', async () => {
    const calls = await dispatch(commandJSON('ping 127.0.0.1 --pub'), subs)
    const defer = getCallback(calls) as { type: number; data: { flags: number } }

    expect(defer.type).toBe(InteractionResponseType.DeferredChannelMessageWithSource)
    expect(defer.data.flags & MessageFlags.Ephemeral).toBeFalsy()
  })
})

describe('ping — autocomplete (selection mode)', () => {
  it('returns ping as a choice when input is empty', async () => {
    const calls = await dispatch(autocompleteJSON(''), subs)
    const body = getCallback(calls) as { type: number; data: { choices: { name: string; value: string }[] } }

    expect(body.type).toBe(InteractionResponseType.ApplicationCommandAutocompleteResult)
    expect(body.data.choices.some((c) => c.value === 'ping')).toBe(true)
  })

  it('returns ping when partially typed', async () => {
    const calls = await dispatch(autocompleteJSON('pi'), subs)
    const body = getCallback(calls) as { type: number; data: { choices: { name: string; value: string }[] } }

    expect(body.data.choices.some((c) => c.value === 'ping')).toBe(true)
  })
})

describe('ping — autocomplete (args mode)', () => {
  it('suggests --ip and --pub flags after subcommand + space', async () => {
    const calls = await dispatch(autocompleteJSON('ping '), subs)
    const body = getCallback(calls) as { type: number; data: { choices: { value: string }[] } }
    const values = body.data.choices.map((c) => c.value)

    expect(values.some((v) => v.includes('--ip'))).toBe(true)
    expect(values.some((v) => v.includes('--pub'))).toBe(true)
  })
})

describe('ping — autocomplete (flag completion mode)', () => {
  it('completes --ip when user types ping --i', async () => {
    const calls = await dispatch(autocompleteJSON('ping --i'), subs)
    const body = getCallback(calls) as { type: number; data: { choices: { value: string }[] } }
    const values = body.data.choices.map((c) => c.value)

    expect(values.some((v) => v.includes('--ip'))).toBe(true)
  })
})

describe('unknown subcommand', () => {
  it('replies with unknown error', async () => {
    const calls = await dispatch(commandJSON('nope'), subs)
    expect(getCallback(calls)).not.toBeNull()
  })
})
