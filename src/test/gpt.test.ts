import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { InteractionResponseType, MessageFlags } from 'discord.js'
import { subcommand as gptCmd } from '../commands/gpt.js'
import {
  commandJSON,
  autocompleteJSON,
  dispatch,
  getCallback,
  getEdit,
  makeSubcommands
} from './e2e.js'

// Mock the openai module so tests don't make real API calls
vi.mock('openai', () => {
  const mockStream = vi.fn(() =>
    (async function* () {
      yield { type: 'response.output_text.delta', delta: 'hello' }
      yield { type: 'response.output_text.delta', delta: ' world' }
    })()
  )

  class MockOpenAI {
    responses = {
      stream: mockStream
    }
  }

  return {
    default: MockOpenAI
  }
})

const subs = makeSubcommands(gptCmd)

beforeEach(() => {
  process.env.OPENAI_API_KEY = 'test-key'
})

afterEach(() => {
  delete process.env.OPENAI_API_KEY
  vi.clearAllMocks()
})

describe('gpt — no prompt', () => {
  it('replies immediately with usage hint', async () => {
    const calls = await dispatch(commandJSON('gpt'), subs)
    const body = getCallback(calls) as { type: number; data: { flags: number } }
    expect(body.type).toBe(InteractionResponseType.ChannelMessageWithSource)
    expect(body.data.flags & MessageFlags.IsComponentsV2).toBeTruthy()
    expect(body.data.flags & MessageFlags.Ephemeral).toBeTruthy()
    expect(getEdit(calls)).toBeNull()
  })
})

describe('gpt — with prompt', () => {
  it('defers then edits with generated content', async () => {
    const calls = await dispatch(commandJSON('gpt explain recursion'), subs)
    const defer = getCallback(calls) as { type: number; data?: { flags?: number } }
    expect(defer.type).toBe(InteractionResponseType.DeferredChannelMessageWithSource)
    expect((defer.data?.flags ?? 0) & MessageFlags.Ephemeral).toBeTruthy()
    const edit = getEdit(calls)
    expect(edit).not.toBeNull()
  })

  it('defers publicly with --pub', async () => {
    const calls = await dispatch(commandJSON('gpt hello --pub'), subs)
    const defer = getCallback(calls) as { type: number; data?: { flags?: number } }
    expect(defer.type).toBe(InteractionResponseType.DeferredChannelMessageWithSource)
    expect((defer.data?.flags ?? 0) & MessageFlags.Ephemeral).toBeFalsy()
  })

  it('edits reply when no API key', async () => {
    delete process.env.OPENAI_API_KEY
    const calls = await dispatch(commandJSON('gpt what is 2+2'), subs)
    const defer = getCallback(calls) as { type: number }
    expect(defer.type).toBe(InteractionResponseType.DeferredChannelMessageWithSource)
    const edit = getEdit(calls) as { components?: unknown } | null
    expect(edit).not.toBeNull()
  })
})

describe('gpt — autocomplete', () => {
  it('returns gpt in selection mode', async () => {
    const calls = await dispatch(autocompleteJSON('gp'), subs)
    const body = getCallback(calls) as {
      type: number
      data: { choices: { value: string }[] }
    }
    expect(body.type).toBe(InteractionResponseType.ApplicationCommandAutocompleteResult)
    expect(body.data.choices.some((c) => c.value === 'gpt')).toBeTruthy()
  })
})
