import { describe, it, expect } from 'vitest'
import { InteractionResponseType, MessageFlags } from 'discord.js'
import { subcommand as sh } from '../commands/sh.js'
import { autocompleteJSON, commandJSON, dispatch, getCallback, makeSubcommands } from './e2e.js'

const subs = makeSubcommands(sh)

describe('sh - command', () => {
  it('defers then edits for echo', async () => {
    const calls = await dispatch(commandJSON('sh echo Hello, world!'), subs)
    const defer = getCallback(calls) as { type: number; data: { flags: number } }
    const text = JSON.stringify(calls)

    expect(defer.type).toBe(InteractionResponseType.DeferredChannelMessageWithSource)
    expect(defer.data.flags & MessageFlags.Ephemeral).toBeTruthy()
    expect(text.includes('Hello, world!')).toBe(true)
    expect(text.includes('code 0')).toBe(true)
  })

  it('lets the real shell handle quotes', async () => {
    const calls = await dispatch(commandJSON('sh echo "Hello spaced world"'), subs)
    const text = JSON.stringify(calls)

    expect(text.includes('Hello spaced world')).toBe(true)
  })

  it('returns exit code and stderr for shell failures', async () => {
    const calls = await dispatch(commandJSON('sh echo bad >&2; exit 3'), subs)
    const text = JSON.stringify(calls)

    expect(text.includes('bad')).toBe(true)
    expect(text.includes('code 3')).toBe(true)
  })

  it('replies publicly with --pub', async () => {
    const calls = await dispatch(commandJSON('sh echo Hello --pub'), subs)
    const body = getCallback(calls) as { type: number; data: { flags: number } }

    expect(body.type).toBe(InteractionResponseType.DeferredChannelMessageWithSource)
    expect(body.data.flags & MessageFlags.Ephemeral).toBeFalsy()
  })

  it('uses short text for empty input', async () => {
    const calls = await dispatch(commandJSON('sh'), subs)
    const body = getCallback(calls) as { type: number }

    expect(body.type).toBe(InteractionResponseType.ChannelMessageWithSource)
    expect(JSON.stringify(body)).toContain('no cmd')
  })
})

describe('sh - autocomplete', () => {
  it('returns sh in selection mode', async () => {
    const calls = await dispatch(autocompleteJSON('s'), subs)
    const body = getCallback(calls) as { type: number; data: { choices: { value: string }[] } }

    expect(body.type).toBe(InteractionResponseType.ApplicationCommandAutocompleteResult)
    expect(body.data.choices.some((choice) => choice.value === 'sh')).toBe(true)
  })
})
