import { afterEach, describe, expect, it, vi } from 'vitest'
import { InteractionResponseType, MessageFlags } from 'discord.js'
import { subcommand as curl } from '../commands/curl.js'
import * as curlRuntime from '../curl-runtime.js'
import {
  autocompleteJSON,
  commandJSON,
  dispatch,
  getCallback,
  getEdit,
  makeSubcommands
} from './e2e.js'

const subs = makeSubcommands(curl)

afterEach(() => {
  vi.restoreAllMocks()
})

describe('curl — command', () => {
  it('replies immediately with usage when url is missing', async () => {
    const calls = await dispatch(commandJSON('curl'), subs)
    const body = getCallback(calls) as { type: number }

    expect(body.type).toBe(InteractionResponseType.ChannelMessageWithSource)
    expect(JSON.stringify(body)).toContain('no url')
  })

  it('defers ephemerally then edits for a simple request', async () => {
    vi.spyOn(curlRuntime, 'executeCurl').mockResolvedValue('**GET google.com**\n-# 200 OK')

    const calls = await dispatch(commandJSON('curl google.com'), subs)
    const defer = getCallback(calls) as { type: number; data: { flags: number } }
    const edit = getEdit(calls)

    expect(defer.type).toBe(InteractionResponseType.DeferredChannelMessageWithSource)
    expect(defer.data.flags & MessageFlags.Ephemeral).toBeTruthy()
    expect(edit).not.toBeNull()
  })

  it('parses short curl flags in spirit of curl syntax', async () => {
    const executeSpy = vi.spyOn(curlRuntime, 'executeCurl').mockResolvedValue('ok')

    await dispatch(
      commandJSON(`curl google.com -X POST -H "Content-Type: application/json" -d '{"hi"}'`),
      subs
    )

    expect(executeSpy).toHaveBeenCalledWith({
      originalTarget: 'google.com',
      url: 'https://google.com/',
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{"hi"}'
    })
  })

  it('defers publicly when --pub flag set', async () => {
    vi.spyOn(curlRuntime, 'executeCurl').mockResolvedValue('**GET google.com**\n-# 200 OK')

    const calls = await dispatch(commandJSON('curl google.com --pub'), subs)
    const defer = getCallback(calls) as { type: number; data: { flags: number } }

    expect(defer.type).toBe(InteractionResponseType.DeferredChannelMessageWithSource)
    expect(defer.data.flags & MessageFlags.Ephemeral).toBeFalsy()
  })
})

describe('curl — autocomplete', () => {
  it('returns curl in selection mode', async () => {
    const calls = await dispatch(autocompleteJSON('cu'), subs)
    const body = getCallback(calls) as { type: number; data: { choices: { value: string }[] } }

    expect(body.type).toBe(InteractionResponseType.ApplicationCommandAutocompleteResult)
    expect(body.data.choices.some((choice) => choice.value === 'curl')).toBe(true)
  })

  it('suggests curl flags in args mode', async () => {
    const calls = await dispatch(autocompleteJSON('curl google.com '), subs)
    const body = getCallback(calls) as { data: { choices: { value: string }[] } }
    const values = body.data.choices.map((choice) => choice.value)

    expect(values.some((value) => value.includes('--method'))).toBe(true)
    expect(values.some((value) => value.includes('--header'))).toBe(true)
    expect(values.some((value) => value.includes('--data'))).toBe(true)
  })
})
