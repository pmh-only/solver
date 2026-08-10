import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { join } from 'node:path'

const { createMock, constructorMock } = vi.hoisted(() => ({
  createMock: vi.fn(),
  constructorMock: vi.fn()
}))

vi.mock('openai', () => ({
  default: class MockOpenAI {
    responses = { create: createMock }

    constructor(options: unknown) {
      constructorMock(options)
    }
  }
}))

import { generateQuizQuestion } from '../commands/quiz-runtime.js'
import { isolateStoredValues } from '../helpers/kv-store-test.js'

const storePath = join(process.cwd(), '.tmp', 'quiz-runtime.test.sqlite')

function response(question = 'Which planet is known as the Red Planet?') {
  return {
    status: 'completed',
    output_text: JSON.stringify({
      question,
      answers: ['Earth', 'Mars', 'Venus', 'Jupiter'],
      correct: 1,
      category: 'science'
    })
  }
}

function options(overrides: Partial<Parameters<typeof generateQuizQuestion>[0]> = {}) {
  return {
    category: 'science' as const,
    locale: 'en-US',
    previousQuestions: [],
    userId: `user-${Math.random()}`,
    ...overrides
  }
}

beforeEach(() => {
  isolateStoredValues(storePath)
  process.env.OPENAI_API_KEY = 'test-key'
  createMock.mockReset()
  constructorMock.mockReset()
  createMock.mockResolvedValue(response())
})

afterEach(() => {
  delete process.env.OPENAI_API_KEY
  vi.useRealTimers()
})

describe('quiz question generation', () => {
  it('requests and validates a structured GPT response', async () => {
    const question = await generateQuizQuestion(options({ userId: 'valid-response' }))

    expect(question).toEqual({
      question: 'Which planet is known as the Red Planet?',
      answers: ['Earth', 'Mars', 'Venus', 'Jupiter'],
      correct: 1,
      category: 'science'
    })
    expect(constructorMock).toHaveBeenCalledWith({
      apiKey: 'test-key',
      baseURL: 'https://api.openai.com/v1',
      maxRetries: 0,
      timeout: 15_000
    })
    expect(createMock).toHaveBeenCalledWith(
      expect.objectContaining({
        model: 'gpt-5.4-mini',
        max_output_tokens: 500,
        text: {
          format: expect.objectContaining({ type: 'json_schema', strict: true })
        }
      }),
      expect.objectContaining({ signal: expect.any(AbortSignal) })
    )
  })

  it('rejects malformed and duplicate generated content', async () => {
    createMock.mockResolvedValueOnce({ status: 'completed', output_text: '{bad json' })
    await expect(generateQuizQuestion(options({ userId: 'bad-json' }))).rejects.toThrow(
      'invalid JSON'
    )

    createMock.mockResolvedValueOnce(response('Already asked?'))
    await expect(
      generateQuizQuestion(
        options({ userId: 'duplicate-question', previousQuestions: [' already   ASKED? '] })
      )
    ).rejects.toThrow('repeated a previous question')
  })

  it('rejects a category mismatch and missing API key', async () => {
    await expect(
      generateQuizQuestion(options({ category: 'history', userId: 'wrong-category' }))
    ).rejects.toThrow('wrong category')

    delete process.env.OPENAI_API_KEY
    await expect(generateQuizQuestion(options({ userId: 'missing-key' }))).rejects.toThrow(
      'OPENAI_API_KEY'
    )
    expect(createMock).toHaveBeenCalledTimes(1)
  })

  it('limits each user to ten generated questions per minute', async () => {
    for (let request = 0; request < 10; request++) {
      await generateQuizQuestion(options({ userId: 'rate-limited-user' }))
    }

    await expect(generateQuizQuestion(options({ userId: 'rate-limited-user' }))).rejects.toThrow(
      'rate limit'
    )
    expect(createMock).toHaveBeenCalledTimes(10)
  })

  it('allows at most two concurrent generation requests', async () => {
    const resolvers: Array<(value: ReturnType<typeof response>) => void> = []
    createMock.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolvers.push(resolve)
        })
    )

    const first = generateQuizQuestion(options({ userId: 'concurrent-1' }))
    const second = generateQuizQuestion(options({ userId: 'concurrent-2' }))
    await expect(generateQuizQuestion(options({ userId: 'concurrent-3' }))).rejects.toThrow('busy')

    resolvers.forEach((resolve) => resolve(response()))
    await expect(Promise.all([first, second])).resolves.toHaveLength(2)
    expect(createMock).toHaveBeenCalledTimes(2)
  })

  it('enforces a durable global hourly request limit', async () => {
    for (let request = 0; request < 120; request++) {
      await generateQuizQuestion(options({ userId: `global-limit-${request}` }))
    }

    await expect(
      generateQuizQuestion(options({ userId: 'global-limit-overflow' }))
    ).rejects.toThrow('global quiz generation limit')
    expect(createMock).toHaveBeenCalledTimes(120)
  })

  it('aborts generation after fifteen seconds', async () => {
    vi.useFakeTimers()
    createMock.mockImplementation(
      (_params: unknown, request: { signal: AbortSignal }) =>
        new Promise((_resolve, reject) => {
          request.signal.addEventListener('abort', () => reject(new Error('aborted')))
        })
    )

    const pending = expect(
      generateQuizQuestion(options({ userId: 'timed-out-user' }))
    ).rejects.toThrow('timed out')
    await vi.advanceTimersByTimeAsync(15_000)
    await pending
  })
})
