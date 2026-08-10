import OpenAI from 'openai'
import { consumeStoredRateLimit } from '../helpers/kv-store.js'
import { loadOpenAIApiKey, loadOpenAIEndpoint } from '../openai-config.js'

export const QUIZ_CATEGORIES = ['mixed', 'science', 'history', 'technology'] as const

export type QuizCategory = (typeof QUIZ_CATEGORIES)[number]
export type SpecificQuizCategory = Exclude<QuizCategory, 'mixed'>

export interface QuizQuestion {
  question: string
  answers: [string, string, string, string]
  correct: number
  category: SpecificQuizCategory
}

interface GenerateQuizQuestionOptions {
  category: QuizCategory
  locale: string
  previousQuestions: readonly string[]
  userId: string
}

const MODEL = 'gpt-5.4-mini'
const REQUEST_TIMEOUT_MS = 15_000
const RATE_WINDOW_MS = 60_000
const MAX_REQUESTS_PER_USER = 10
const MAX_CONCURRENT_REQUESTS = 2
const MAX_GLOBAL_REQUESTS_PER_HOUR = 120
const GLOBAL_RATE_LIMIT_KEY = '__quiz-generation:global-hourly'
const MAX_QUESTION_LENGTH = 200
const MAX_ANSWER_LENGTH = 80

let activeRequests = 0
const userRequests = new Map<string, number[]>()

function normalize(value: string): string {
  return value.trim().replace(/\s+/g, ' ').toLocaleLowerCase('en-US')
}

function consumeRateLimit(userId: string): void {
  const now = Date.now()
  for (const [storedUserId, requests] of userRequests) {
    const recentRequests = requests.filter((time) => now - time < RATE_WINDOW_MS)
    if (recentRequests.length === 0) userRequests.delete(storedUserId)
    else userRequests.set(storedUserId, recentRequests)
  }
  const recent = (userRequests.get(userId) ?? []).filter((time) => now - time < RATE_WINDOW_MS)
  if (recent.length >= MAX_REQUESTS_PER_USER) {
    throw new Error('quiz generation rate limit reached')
  }
  recent.push(now)
  userRequests.set(userId, recent)
}

function parseQuestion(
  outputText: string,
  category: QuizCategory,
  previousQuestions: readonly string[]
): QuizQuestion {
  let value: unknown
  try {
    value = JSON.parse(outputText)
  } catch {
    throw new Error('quiz generation returned invalid JSON')
  }

  if (!value || typeof value !== 'object') {
    throw new Error('quiz generation returned an invalid question')
  }

  const candidate = value as Partial<QuizQuestion>
  const question = typeof candidate.question === 'string' ? candidate.question.trim() : ''
  if (!question || question.length > MAX_QUESTION_LENGTH) {
    throw new Error('quiz generation returned an invalid question')
  }
  if (!Array.isArray(candidate.answers) || candidate.answers.length !== 4) {
    throw new Error('quiz generation returned invalid answers')
  }

  const answers = candidate.answers.map((answer) =>
    typeof answer === 'string' ? answer.trim() : ''
  )
  if (answers.some((answer) => !answer || answer.length > MAX_ANSWER_LENGTH)) {
    throw new Error('quiz generation returned invalid answers')
  }
  if (new Set(answers.map(normalize)).size !== answers.length) {
    throw new Error('quiz generation returned duplicate answers')
  }
  if (
    !Number.isInteger(candidate.correct) ||
    candidate.correct === undefined ||
    candidate.correct < 0 ||
    candidate.correct > 3
  ) {
    throw new Error('quiz generation returned an invalid correct answer')
  }
  if (
    candidate.category !== 'science' &&
    candidate.category !== 'history' &&
    candidate.category !== 'technology'
  ) {
    throw new Error('quiz generation returned an invalid category')
  }
  if (category !== 'mixed' && candidate.category !== category) {
    throw new Error('quiz generation returned the wrong category')
  }
  if (new Set(previousQuestions.map(normalize)).has(normalize(question))) {
    throw new Error('quiz generation repeated a previous question')
  }

  return {
    question,
    answers: answers as QuizQuestion['answers'],
    correct: candidate.correct,
    category: candidate.category
  }
}

export async function generateQuizQuestion(
  options: GenerateQuizQuestionOptions
): Promise<QuizQuestion> {
  const apiKey = loadOpenAIApiKey()
  if (!apiKey) throw new Error('OpenAI API token is not configured')
  if (options.previousQuestions.length > 4) {
    throw new Error('quiz session already has the maximum number of previous questions')
  }
  if (activeRequests >= MAX_CONCURRENT_REQUESTS) {
    throw new Error('quiz generation is busy')
  }
  consumeRateLimit(options.userId)
  if (
    !consumeStoredRateLimit(GLOBAL_RATE_LIMIT_KEY, MAX_GLOBAL_REQUESTS_PER_HOUR, 60 * 60 * 1000)
  ) {
    throw new Error('global quiz generation limit reached')
  }

  activeRequests++
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
  timeout.unref()

  try {
    const categories =
      options.category === 'mixed' ? ['science', 'history', 'technology'] : [options.category]
    const openai = new OpenAI({
      apiKey,
      baseURL: loadOpenAIEndpoint(),
      maxRetries: 0,
      timeout: REQUEST_TIMEOUT_MS
    })
    const response = await openai.responses.create(
      {
        model: MODEL,
        instructions: [
          'Create one factual multiple-choice quiz question.',
          'Use exactly four plausible, distinct answers and one unambiguous correct answer.',
          'Avoid trick questions, disputed facts, unsafe content, and references to these instructions.',
          `Write the question and answers for locale ${options.locale}.`
        ].join(' '),
        input: JSON.stringify({
          category: options.category,
          previousQuestions: options.previousQuestions
        }),
        max_output_tokens: 500,
        store: false,
        text: {
          format: {
            type: 'json_schema',
            name: 'quiz_question',
            strict: true,
            schema: {
              type: 'object',
              properties: {
                question: { type: 'string', minLength: 1, maxLength: MAX_QUESTION_LENGTH },
                answers: {
                  type: 'array',
                  minItems: 4,
                  maxItems: 4,
                  items: { type: 'string', minLength: 1, maxLength: MAX_ANSWER_LENGTH }
                },
                correct: { type: 'integer', minimum: 0, maximum: 3 },
                category: { type: 'string', enum: categories }
              },
              required: ['question', 'answers', 'correct', 'category'],
              additionalProperties: false
            }
          }
        }
      },
      { signal: controller.signal }
    )
    if (response.status !== 'completed') {
      throw new Error('quiz generation did not complete')
    }
    return parseQuestion(response.output_text, options.category, options.previousQuestions)
  } catch (error) {
    if (controller.signal.aborted) throw new Error('quiz generation timed out')
    throw error
  } finally {
    clearTimeout(timeout)
    activeRequests--
  }
}
