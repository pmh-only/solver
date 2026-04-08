import { afterEach, describe, expect, it, vi } from 'vitest'
import { InteractionResponseType, MessageFlags } from 'discord.js'
import { EDIT_PARAMETERS_BUTTON_ID, PIN_BUTTON_ID, PUB_BUTTON_ID } from '../components.js'
import { subcommand as ping } from '../commands/ping.js'
import { clearStoredValues } from '../helpers/kv-store.js'
import * as pingRuntime from '../ping-runtime.js'
import {
  buttonJSON,
  commandJSON,
  autocompleteJSON,
  dispatch,
  getCallback,
  getEdit,
  makeSubcommands,
  modalJSON
} from './e2e.js'

const subs = makeSubcommands(ping)

afterEach(() => {
  clearStoredValues()
  vi.restoreAllMocks()
  vi.useRealTimers()
})

function stripCommandFooter(components: unknown): unknown {
  if (Array.isArray(components)) {
    return components.map((component) => stripCommandFooter(component))
  }

  if (!components || typeof components !== 'object') return components

  const record = components as { content?: unknown; components?: unknown[] }
  const next: Record<string, unknown> = { ...record }

  if (typeof record.content === 'string') {
    next.content = record.content.replace(/\n\n-# `[^`]+`/g, '')
  }

  if (Array.isArray(record.components)) {
    next.components = record.components.map((component) => stripCommandFooter(component))
  }

  return next
}

describe('ping — command', () => {
  it('replies with pong when no host given', async () => {
    vi.useFakeTimers()

    const calls = await dispatch(commandJSON('ping'), subs)
    const body = getCallback(calls) as { type: number; data: { flags: number } }

    expect(body.type).toBe(InteractionResponseType.ChannelMessageWithSource)
    expect(body.data.flags & MessageFlags.Ephemeral).toBeTruthy() // ephemeral by default

    await vi.advanceTimersByTimeAsync(60_000)

    expect(calls.some((call) => call.method === 'DELETE')).toBe(true)
  })

  it('defers ephemerally then edits when host given as bare arg', async () => {
    vi.useFakeTimers()

    vi.spyOn(pingRuntime, 'probePingTarget').mockResolvedValue({
      host: '127.0.0.1',
      count: 2,
      types: ['icmp', 'http'],
      summaries: [
        { type: 'icmp', count: 2, ms: [], note: 'unavailable in this runtime' },
        { type: 'http', count: 2, ms: [10, 12] }
      ]
    })

    const calls = await dispatch(commandJSON('ping 127.0.0.1'), subs)
    const defer = getCallback(calls) as { type: number; data: { flags: number } }
    const edit = getEdit(calls) as { components: unknown[] }

    expect(defer.type).toBe(InteractionResponseType.DeferredChannelMessageWithSource)
    expect(defer.data.flags & MessageFlags.Ephemeral).toBeTruthy()
    expect(edit.components).toBeDefined()
    expect(JSON.stringify(edit)).toContain('Retry')
    expect(JSON.stringify(edit)).toContain('Edit parameters')

    await vi.advanceTimersByTimeAsync(60_000)

    expect(calls.some((call) => call.method === 'DELETE')).toBe(true)
  })

  it('defers ephemerally then edits when host given via --ip flag', async () => {
    vi.spyOn(pingRuntime, 'probePingTarget').mockResolvedValue({
      host: '127.0.0.1',
      count: 3,
      types: ['https'],
      summaries: [{ type: 'https', count: 3, ms: [20, 21, 22] }]
    })

    const calls = await dispatch(commandJSON('ping --ip 127.0.0.1'), subs)
    const defer = getCallback(calls) as { type: number; data: { flags: number } }
    const edit = getEdit(calls)

    expect(defer.type).toBe(InteractionResponseType.DeferredChannelMessageWithSource)
    expect(edit).not.toBeNull()
  })

  it('accepts short count syntax before the host', async () => {
    const probeSpy = vi.spyOn(pingRuntime, 'probePingTarget').mockResolvedValue({
      host: '1.1.1.1',
      count: 5,
      types: ['http'],
      summaries: [{ type: 'http', count: 5, ms: [9, 10, 11, 12, 13] }]
    })

    const calls = await dispatch(commandJSON('ping -c 5 1.1.1.1 --type http'), subs)
    const defer = getCallback(calls) as { type: number }

    expect(defer.type).toBe(InteractionResponseType.DeferredChannelMessageWithSource)
    expect(probeSpy).toHaveBeenCalledWith({
      host: '1.1.1.1',
      count: 5,
      types: ['http']
    })
  })

  it('defers publicly when --pub flag set', async () => {
    vi.useFakeTimers()

    vi.spyOn(pingRuntime, 'probePingTarget').mockResolvedValue({
      host: '127.0.0.1',
      count: 1,
      types: ['http3'],
      summaries: [
        {
          type: 'http3',
          count: 1,
          ms: [35],
          note: 'measured via a QUIC Initial probe rather than a full HTTP/3 request'
        }
      ]
    })

    const calls = await dispatch(commandJSON('ping 127.0.0.1 --pub'), subs)
    const defer = getCallback(calls) as { type: number; data: { flags: number } }

    expect(defer.type).toBe(InteractionResponseType.DeferredChannelMessageWithSource)
    expect(defer.data.flags & MessageFlags.Ephemeral).toBeFalsy()

    await vi.advanceTimersByTimeAsync(60_000)

    expect(calls.some((call) => call.method === 'DELETE')).toBe(false)
  })

  it('re-runs a deferred command from the Retry button footer args', async () => {
    vi.spyOn(pingRuntime, 'probePingTarget')
      .mockResolvedValueOnce({
        host: '127.0.0.1',
        count: 2,
        types: ['http'],
        summaries: [{ type: 'http', count: 2, ms: [10, 11] }]
      })
      .mockResolvedValueOnce({
        host: '127.0.0.1',
        count: 2,
        types: ['http'],
        summaries: [{ type: 'http', count: 2, ms: [12, 13] }]
      })

    const firstCalls = await dispatch(commandJSON('ping 127.0.0.1 --type http'), subs)
    const firstEdit = getEdit(firstCalls) as { components: unknown[] }

    const retryCalls = await dispatch(buttonJSON(firstEdit.components), subs)
    const defer = getCallback(retryCalls) as { type: number; data: { flags: number } }
    const retryEdit = getEdit(retryCalls)

    expect(defer.type).toBe(InteractionResponseType.DeferredMessageUpdate)
    expect(retryEdit).not.toBeNull()
    expect(pingRuntime.probePingTarget).toHaveBeenCalledTimes(2)
    expect(JSON.stringify(retryEdit)).toContain('ping 127.0.0.1 --type http')
  })

  it('re-runs from the Retry button even when the footer text is missing', async () => {
    vi.spyOn(pingRuntime, 'probePingTarget')
      .mockResolvedValueOnce({
        host: '127.0.0.1',
        count: 2,
        types: ['http'],
        summaries: [{ type: 'http', count: 2, ms: [10, 11] }]
      })
      .mockResolvedValueOnce({
        host: '127.0.0.1',
        count: 2,
        types: ['http'],
        summaries: [{ type: 'http', count: 2, ms: [12, 13] }]
      })

    const firstCalls = await dispatch(commandJSON('ping 127.0.0.1 --type http'), subs)
    const firstEdit = getEdit(firstCalls) as { components: unknown[] }
    const retryCalls = await dispatch(
      buttonJSON(stripCommandFooter(firstEdit.components) as unknown[]),
      subs
    )
    const retryEdit = getEdit(retryCalls)

    expect(retryEdit).not.toBeNull()
    expect(pingRuntime.probePingTarget).toHaveBeenCalledTimes(2)
  })

  it('opens a modal with the current command input', async () => {
    vi.spyOn(pingRuntime, 'probePingTarget').mockResolvedValue({
      host: '127.0.0.1',
      count: 1,
      types: ['http'],
      summaries: [{ type: 'http', count: 1, ms: [10] }]
    })

    const firstCalls = await dispatch(commandJSON('ping 127.0.0.1 --type http'), subs)
    const firstEdit = getEdit(firstCalls) as { components: unknown[] }
    const modalCalls = await dispatch(
      buttonJSON(firstEdit.components, EDIT_PARAMETERS_BUTTON_ID),
      subs
    )
    const body = getCallback(modalCalls) as { type: number; data: { components: unknown[] } }

    expect(body.type).toBe(InteractionResponseType.Modal)
    expect(JSON.stringify(body.data.components)).toContain('ping 127.0.0.1 --type http')
  })

  it('publishes output without any buttons', async () => {
    vi.spyOn(pingRuntime, 'probePingTarget').mockResolvedValue({
      host: '127.0.0.1',
      count: 1,
      types: ['http'],
      summaries: [{ type: 'http', count: 1, ms: [10] }]
    })

    const firstCalls = await dispatch(commandJSON('ping 127.0.0.1'), subs)
    const firstEdit = getEdit(firstCalls) as { components: unknown[] }
    const publishCalls = await dispatch(buttonJSON(firstEdit.components, PUB_BUTTON_ID), subs)
    const body = getCallback(publishCalls) as { type: number; data: { components: unknown[] } }

    expect(body.type).toBe(InteractionResponseType.ChannelMessageWithSource)
    expect(JSON.stringify(body.data.components)).not.toContain('Retry')
    expect(JSON.stringify(body.data.components)).not.toContain('Edit parameters')
    expect(JSON.stringify(body.data.components)).not.toContain(PUB_BUTTON_ID)
  })

  it('pins an ephemeral reply so it is not auto-deleted', async () => {
    vi.useFakeTimers()

    vi.spyOn(pingRuntime, 'probePingTarget').mockResolvedValue({
      host: '127.0.0.1',
      count: 1,
      types: ['http'],
      summaries: [{ type: 'http', count: 1, ms: [10] }]
    })

    const firstCalls = await dispatch(commandJSON('ping 127.0.0.1'), subs)
    const firstEdit = getEdit(firstCalls) as { components: unknown[] }
    const pinCalls = await dispatch(buttonJSON(firstEdit.components, PIN_BUTTON_ID), subs)
    const body = getCallback(pinCalls) as { type: number; data: { components: unknown[] } }

    expect(body.type).toBe(InteractionResponseType.UpdateMessage)
    expect(JSON.stringify(body.data.components)).toContain('Pinned')

    await vi.advanceTimersByTimeAsync(60_000)

    expect(firstCalls.some((call) => call.method === 'DELETE')).toBe(false)
  })

  it('re-runs edited parameters from the modal and keeps --pub public', async () => {
    const probeSpy = vi.spyOn(pingRuntime, 'probePingTarget').mockResolvedValue({
      host: '1.1.1.1',
      count: 3,
      types: ['https'],
      summaries: [{ type: 'https', count: 3, ms: [20, 21, 22] }]
    })

    const calls = await dispatch(modalJSON('ping 1.1.1.1 --type https --pub'), subs)
    const defer = getCallback(calls) as { type: number; data: { flags: number } }
    const edit = getEdit(calls)

    expect(defer.type).toBe(InteractionResponseType.DeferredChannelMessageWithSource)
    expect(defer.data.flags & MessageFlags.Ephemeral).toBeFalsy()
    expect(edit).not.toBeNull()
    expect(probeSpy).toHaveBeenCalledWith({
      host: '1.1.1.1',
      count: 3,
      types: ['https']
    })
  })

  it('rejects unsupported probe types immediately', async () => {
    const calls = await dispatch(commandJSON('ping example.com --type tcp'), subs)
    const body = getCallback(calls) as {
      type: number
      data: { components: Array<{ components?: Array<{ text?: string; content?: string }> }> }
    }

    expect(body.type).toBe(InteractionResponseType.ChannelMessageWithSource)
    expect(JSON.stringify(body)).toContain('bad type')
  })
})

describe('ping — autocomplete (selection mode)', () => {
  it('returns ping as a choice when input is empty', async () => {
    const calls = await dispatch(autocompleteJSON(''), subs)
    const body = getCallback(calls) as {
      type: number
      data: { choices: { name: string; value: string }[] }
    }

    expect(body.type).toBe(InteractionResponseType.ApplicationCommandAutocompleteResult)
    expect(body.data.choices.some((c) => c.value === 'ping')).toBe(true)
  })

  it('returns ping when partially typed', async () => {
    const calls = await dispatch(autocompleteJSON('pi'), subs)
    const body = getCallback(calls) as {
      type: number
      data: { choices: { name: string; value: string }[] }
    }

    expect(body.data.choices.some((c) => c.value === 'ping')).toBe(true)
  })
})

describe('ping — autocomplete (args mode)', () => {
  it('suggests --ip and --pub flags after subcommand + space', async () => {
    const calls = await dispatch(autocompleteJSON('ping '), subs)
    const body = getCallback(calls) as { type: number; data: { choices: { value: string }[] } }
    const values = body.data.choices.map((c) => c.value)

    expect(values.some((v) => v.includes('--ip'))).toBe(true)
    expect(values.some((v) => v.includes('--count'))).toBe(true)
    expect(values.some((v) => v.includes('--type'))).toBe(true)
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
