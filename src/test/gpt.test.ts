import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { InteractionResponseType, MessageFlags } from 'discord.js'
import { agentCommand } from '../application-commands.js'
import {
  agentCommandJSON,
  autocompleteJSON,
  dispatch,
  getCallback,
  getEdit,
  makeSubcommands
} from './e2e.js'

const { modelMock } = vi.hoisted(() => ({ modelMock: vi.fn() }))

vi.mock('@strands-agents/sdk/models/openai', () => ({
  OpenAIModel: class MockOpenAIModel {
    constructor(options: unknown) {
      modelMock(options)
    }
  }
}))

vi.mock('@strands-agents/sdk', () => ({
  Agent: class MockAgent {
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
})

afterEach(() => {
  delete process.env.OPENAI_API_KEY
  vi.clearAllMocks()
})

describe('/a', () => {
  it('is registered as a dedicated command with only a prompt option', () => {
    const command = agentCommand.toJSON()

    expect(command.name).toBe('a')
    expect(command.options?.map((option) => option.name)).toEqual(['prompt'])
    expect(command.options?.[0]).toMatchObject({ name: 'prompt', required: true })
  })

  it('always responds publicly without a footer', async () => {
    const calls = await dispatch(agentCommandJSON('explain recursion'), subs)
    const defer = getCallback(calls) as { type: number; data?: { flags?: number } }
    expect(defer.type).toBe(InteractionResponseType.DeferredChannelMessageWithSource)
    expect((defer.data?.flags ?? 0) & MessageFlags.Ephemeral).toBeFalsy()
    const edit = getEdit(calls)
    expect(edit).not.toBeNull()
    expect(JSON.stringify(calls)).toContain('hello world')
    expect(JSON.stringify(calls)).not.toContain('`/a explain recursion`')
    expect(modelMock).toHaveBeenCalledWith(
      expect.objectContaining({ api: 'responses', apiKey: 'test-key', modelId: 'gpt-5.4' })
    )
  })

  it('edits reply when no API key', async () => {
    delete process.env.OPENAI_API_KEY
    const calls = await dispatch(agentCommandJSON('what is 2+2'), subs)
    const defer = getCallback(calls) as { type: number }
    expect(defer.type).toBe(InteractionResponseType.DeferredChannelMessageWithSource)
    const edit = getEdit(calls) as { components?: unknown } | null
    expect(edit).not.toBeNull()
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
