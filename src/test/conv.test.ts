import { describe, it, expect, afterEach, vi } from 'vitest'
import { InteractionResponseType, MessageFlags } from 'discord.js'
import { subcommand as conv } from '../commands/conv.js'
import { convertValue, inspectConvRequest } from '../commands/conv_core.js'
import {
  autocompleteJSON,
  commandJSON,
  dispatch,
  getCallback,
  getEdit,
  makeSubcommands
} from './e2e.js'

const subs = makeSubcommands(conv)

describe('conv — helpers', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('parses currency inputs with separated and compact source units', () => {
    expect(inspectConvRequest('1 usd to krw')).toMatchObject({
      kind: 'currency',
      amount: 1,
      from: 'USD',
      to: 'KRW'
    })
    expect(inspectConvRequest('1usd to krw')).toMatchObject({
      kind: 'currency',
      amount: 1,
      from: 'USD',
      to: 'KRW'
    })
  })

  it('handles string encoding conversions directly', async () => {
    await expect(convertValue('hello, world! to base64')).resolves.toBe('aGVsbG8sIHdvcmxkIQ==')
    await expect(convertValue('aGVsbG8sIHdvcmxk from base64')).resolves.toBe('hello, world')
    await expect(convertValue('aGVsbG8sIHdvcmxk from base64 to hex')).resolves.toBe(
      '68656c6c6f2c20776f726c64'
    )
    await expect(convertValue('hello, world! to hex')).resolves.toBe('68656c6c6f2c20776f726c6421')
  })

  it('handles integer base conversions directly', async () => {
    await expect(convertValue('10 to hex')).resolves.toBe('a')
    await expect(convertValue('10 from bin')).resolves.toBe('2')
    await expect(convertValue('10 from bin to hex')).resolves.toBe('2')
  })

  it('uses frankfurter for currency conversion', async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify({ rates: { KRW: 1432.5 } }), {
          status: 200,
          headers: { 'content-type': 'application/json' }
        })
    )
    vi.stubGlobal('fetch', fetchMock)

    await expect(convertValue('1 usd to krw')).resolves.toBe('1 USD = 1432.5 KRW')
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const firstCall = fetchMock.mock.calls[0] as unknown[] | undefined
    expect(String(firstCall?.[0])).toContain('api.frankfurter.app/latest')
  })
})

describe('conv — command', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('replies immediately for non-network conversions', async () => {
    const calls = await dispatch(commandJSON('conv hello, world! to base64'), subs)
    const body = getCallback(calls) as { type: number; data: { flags: number } }

    expect(body.type).toBe(InteractionResponseType.ChannelMessageWithSource)
    expect(body.data.flags & MessageFlags.Ephemeral).toBeTruthy()
    expect(JSON.stringify(body)).toContain('aGVsbG8sIHdvcmxkIQ==')
  })

  it('defers ephemerally then edits for currency conversion', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(JSON.stringify({ rates: { KRW: 1400 } }), {
            status: 200,
            headers: { 'content-type': 'application/json' }
          })
      )
    )

    const calls = await dispatch(commandJSON('conv 1 usd to krw'), subs)
    const defer = getCallback(calls) as { type: number; data: { flags: number } }
    const edit = getEdit(calls)

    expect(defer.type).toBe(InteractionResponseType.DeferredChannelMessageWithSource)
    expect(defer.data.flags & MessageFlags.Ephemeral).toBeTruthy()
    expect(JSON.stringify(edit)).toContain('1 USD = 1400 KRW')
  })

  it('defers publicly when --pub is set', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(JSON.stringify({ rates: { KRW: 1400 } }), {
            status: 200,
            headers: { 'content-type': 'application/json' }
          })
      )
    )

    const calls = await dispatch(commandJSON('conv 1 usd to krw --pub'), subs)
    const defer = getCallback(calls) as { type: number; data: { flags: number } }

    expect(defer.type).toBe(InteractionResponseType.DeferredChannelMessageWithSource)
    expect(defer.data.flags & MessageFlags.Ephemeral).toBeFalsy()
  })
})

describe('conv — autocomplete', () => {
  it('returns conv in selection mode', async () => {
    const calls = await dispatch(autocompleteJSON('co'), subs)
    const body = getCallback(calls) as { type: number; data: { choices: { value: string }[] } }

    expect(body.type).toBe(InteractionResponseType.ApplicationCommandAutocompleteResult)
    expect(body.data.choices.some((choice) => choice.value === 'conv')).toBe(true)
  })
})
