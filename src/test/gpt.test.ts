import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { InteractionResponseType, MessageFlags } from 'discord.js'
import { agentCommand } from '../application-commands.js'
import { clearStoredValues, getStoredValue } from '../helpers/kv-store.js'
import {
  agentCommandJSON,
  autocompleteJSON,
  dispatch,
  getCallback,
  getEdit,
  makeSubcommands
} from './e2e.js'

const { agentMock, modelMock } = vi.hoisted(() => ({ agentMock: vi.fn(), modelMock: vi.fn() }))

vi.mock('@strands-agents/sdk/models/openai', () => ({
  OpenAIModel: class MockOpenAIModel {
    constructor(options: unknown) {
      modelMock(options)
    }
  }
}))

vi.mock('@strands-agents/sdk', () => ({
  Agent: class MockAgent {
    constructor(options: unknown) {
      agentMock(options)
    }

    async *stream() {
      for (const text of ['hello', ' world']) {
        yield {
          type: 'modelStreamUpdateEvent',
          event: { type: 'modelContentBlockDeltaEvent', delta: { type: 'textDelta', text } }
        }
      }
    }
  }
}))

const subs = makeSubcommands()

beforeEach(() => {
  process.env.OPENAI_API_KEY = 'test-key'
  clearStoredValues()
})

afterEach(() => {
  delete process.env.OPENAI_API_KEY
  vi.clearAllMocks()
})

describe('/a', () => {
  it('is registered as a dedicated command with prompt and optional session options', () => {
    const command = agentCommand.toJSON()

    expect(command.name).toBe('a')
    expect(command.options?.map((option) => option.name)).toEqual(['prompt', 'session'])
    expect(command.options?.[0]).toMatchObject({ name: 'prompt', required: true })
    expect(command.options?.[1]).toMatchObject({ name: 'session', required: false })
  })

  it('always responds publicly with the selected session in the footer', async () => {
    const calls = await dispatch(agentCommandJSON('explain recursion'), subs)
    const defer = getCallback(calls) as { type: number; data?: { flags?: number } }
    expect(defer.type).toBe(InteractionResponseType.DeferredChannelMessageWithSource)
    expect((defer.data?.flags ?? 0) & MessageFlags.Ephemeral).toBeFalsy()
    const edit = getEdit(calls)
    expect(edit).not.toBeNull()
    expect(JSON.stringify(calls)).toContain('hello world')
    expect(JSON.stringify(calls)).toContain('Session: default')
    expect(JSON.stringify(calls)).not.toContain('`/a explain recursion`')
    expect(modelMock).toHaveBeenCalledWith(
      expect.objectContaining({ api: 'responses', apiKey: 'test-key', modelId: 'gpt-5.4' })
    )
  })

  it('retains full conversation history in the selected session', async () => {
    await dispatch(agentCommandJSON('first question'), subs)
    await dispatch(agentCommandJSON('second question'), subs)

    expect(agentMock).toHaveBeenLastCalledWith(
      expect.objectContaining({
        messages: [
          expect.objectContaining({ role: 'user', content: [{ text: 'first question' }] }),
          expect.objectContaining({ role: 'assistant', content: [{ text: 'hello world' }] })
        ]
      })
    )
  })

  it('switches to a new session and keeps it selected', async () => {
    await dispatch(agentCommandJSON('default question'), subs)
    const switched = await dispatch(agentCommandJSON('work question', {}, 'work'), subs)
    const continued = await dispatch(agentCommandJSON('follow-up'), subs)

    expect(JSON.stringify(switched)).toContain('Session: work')
    expect(JSON.stringify(continued)).toContain('Session: work')
    expect(agentMock).toHaveBeenLastCalledWith(
      expect.objectContaining({
        messages: [
          expect.objectContaining({ role: 'user', content: [{ text: 'work question' }] }),
          expect.objectContaining({ role: 'assistant', content: [{ text: 'hello world' }] })
        ]
      })
    )
  })

  it('serializes overlapping requests in the same session', async () => {
    await Promise.all([
      dispatch(agentCommandJSON('first concurrent question'), subs),
      dispatch(agentCommandJSON('second concurrent question'), subs)
    ])

    expect(agentMock).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        messages: [
          expect.objectContaining({
            role: 'user',
            content: [{ text: 'first concurrent question' }]
          }),
          expect.objectContaining({ role: 'assistant', content: [{ text: 'hello world' }] })
        ]
      })
    )
  })

  it('keeps multiline session names on one escaped footer line', async () => {
    const calls = await dispatch(agentCommandJSON('question', {}, 'work\n# notes'), subs)

    expect(JSON.stringify(calls)).toContain('Session: work # notes')
    expect(JSON.stringify(calls)).not.toContain('Session: work\\n# notes')
  })

  it('edits reply when no API key', async () => {
    delete process.env.OPENAI_API_KEY
    const calls = await dispatch(agentCommandJSON('what is 2+2'), subs)
    const defer = getCallback(calls) as { type: number }
    expect(defer.type).toBe(InteractionResponseType.DeferredChannelMessageWithSource)
    const edit = getEdit(calls) as { components?: unknown } | null
    expect(edit).not.toBeNull()
    expect(getStoredValue('gpt-session:666666666666666666:default')).toBe('[]')
  })

  it('is no longer exposed through /c autocomplete', async () => {
    const calls = await dispatch(autocompleteJSON('gp'), subs)
    const body = getCallback(calls) as {
      type: number
      data: { choices: { value: string }[] }
    }
    expect(body.type).toBe(InteractionResponseType.ApplicationCommandAutocompleteResult)
    expect(body.data.choices.some((c) => c.value === 'gpt')).toBeFalsy()
  })
})
