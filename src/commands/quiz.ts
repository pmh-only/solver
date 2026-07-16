import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  MessageFlags,
  type ButtonInteraction
} from 'discord.js'
import { randomUUID } from 'node:crypto'
import type { Subcommand } from '../types.js'
import {
  deleteStoredValue,
  getStoredValue,
  listStoredKeys,
  setStoredValue
} from '../helpers/kv-store.js'
import { isPubtabContext } from '../flags.js'
import { commandReferenceReply, sendCommandReply, withPubtabButton } from '../components.js'
import { createGamePresentation, type GamePresentation } from '../canvas-presentation.js'

export const QUIZ_ANSWER_BUTTON_ID = 'quiz-answer'
export const QUIZ_NEXT_BUTTON_ID = 'quiz-next'

const QUIZ_STATE_KEY = '__quiz-state'
const QUIZ_STATE_TTL_MS = 60 * 60 * 1000
const QUIZ_ROUNDS = 5
const QUIZ_CATEGORIES = ['mixed', 'science', 'history', 'technology'] as const

type QuizCategory = (typeof QUIZ_CATEGORIES)[number]

interface QuizQuestion {
  question: string
  answers: readonly [string, string, string, string]
  correct: number
  category: Exclude<QuizCategory, 'mixed'>
}

const QUIZ_QUESTIONS: readonly QuizQuestion[] = [
  {
    question: 'Which planet is known as the Red Planet?',
    answers: ['Earth', 'Mars', 'Venus', 'Jupiter'],
    correct: 1,
    category: 'science'
  },
  {
    question: 'What gas do plants absorb from the atmosphere?',
    answers: ['Oxygen', 'Hydrogen', 'Carbon dioxide', 'Helium'],
    correct: 2,
    category: 'science'
  },
  {
    question: 'What is the chemical symbol for gold?',
    answers: ['Ag', 'Au', 'Gd', 'Go'],
    correct: 1,
    category: 'science'
  },
  {
    question: 'How many bones are in the adult human body?',
    answers: ['186', '206', '226', '246'],
    correct: 1,
    category: 'science'
  },
  {
    question: 'Which force keeps planets in orbit around the Sun?',
    answers: ['Friction', 'Magnetism', 'Gravity', 'Buoyancy'],
    correct: 2,
    category: 'science'
  },
  {
    question: 'What is the largest organ in the human body?',
    answers: ['Heart', 'Liver', 'Lungs', 'Skin'],
    correct: 3,
    category: 'science'
  },
  {
    question: 'Which ancient civilization built Machu Picchu?',
    answers: ['Aztec', 'Inca', 'Maya', 'Roman'],
    correct: 1,
    category: 'history'
  },
  {
    question: 'In which year did World War II end?',
    answers: ['1943', '1944', '1945', '1946'],
    correct: 2,
    category: 'history'
  },
  {
    question: 'Who was the first person to walk on the Moon?',
    answers: ['Buzz Aldrin', 'Yuri Gagarin', 'Neil Armstrong', 'John Glenn'],
    correct: 2,
    category: 'history'
  },
  {
    question: 'The Magna Carta was sealed in which country?',
    answers: ['England', 'France', 'Italy', 'Spain'],
    correct: 0,
    category: 'history'
  },
  {
    question: 'Which city was buried by Mount Vesuvius in 79 CE?',
    answers: ['Athens', 'Pompeii', 'Sparta', 'Carthage'],
    correct: 1,
    category: 'history'
  },
  {
    question: 'Which empire used roads called the Royal Road?',
    answers: ['Persian', 'Ottoman', 'Mughal', 'Byzantine'],
    correct: 0,
    category: 'history'
  },
  {
    question: 'What does CPU stand for?',
    answers: [
      'Central Processing Unit',
      'Computer Personal Utility',
      'Core Program User',
      'Central Power Unit'
    ],
    correct: 0,
    category: 'technology'
  },
  {
    question: 'Which language is primarily used to style web pages?',
    answers: ['HTML', 'CSS', 'SQL', 'Python'],
    correct: 1,
    category: 'technology'
  },
  {
    question: 'What does HTTP stand for?',
    answers: [
      'Hypertext Transfer Protocol',
      'High Transfer Text Process',
      'Hosted Terminal Transport Program',
      'Hyperlink Text Transfer Package'
    ],
    correct: 0,
    category: 'technology'
  },
  {
    question: 'Which number system uses only 0 and 1?',
    answers: ['Decimal', 'Hexadecimal', 'Binary', 'Octal'],
    correct: 2,
    category: 'technology'
  },
  {
    question: 'What kind of database organizes data into tables?',
    answers: ['Relational', 'Graphical', 'Documentary', 'Sequential'],
    correct: 0,
    category: 'technology'
  },
  {
    question: 'Which protocol securely connects to a remote shell?',
    answers: ['FTP', 'SMTP', 'SSH', 'DNS'],
    correct: 2,
    category: 'technology'
  }
] as const

interface QuizState {
  commandInput: string
  pub: boolean
  pubtab: boolean
  category: QuizCategory
  questionIndex: number
  questionIndices: number[]
  chooser: string
  score: number
  streak: number
  bestStreak: number
  updatedAt: number
  lastAnswer?: number
  correct?: boolean
}

function stateKey(token: string): string {
  return `${QUIZ_STATE_KEY}:${token}`
}

function storeState(token: string, state: QuizState): void {
  state.updatedAt = Date.now()
  setStoredValue(stateKey(token), JSON.stringify(state))
}

function isQuestionIndex(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isInteger(value) &&
    value >= 0 &&
    value < QUIZ_QUESTIONS.length
  )
}

function isCategory(value: unknown): value is QuizCategory {
  return QUIZ_CATEGORIES.some((category) => category === value)
}

function isSessionCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= QUIZ_ROUNDS
}

function loadState(token: string): QuizState | null {
  const stored = getStoredValue(stateKey(token))
  if (!stored) return null

  try {
    const parsed = JSON.parse(stored) as Partial<QuizState>
    if (typeof parsed.commandInput !== 'string' || !parsed.commandInput) return null
    if (typeof parsed.chooser !== 'string' || !parsed.chooser) return null
    if (!isQuestionIndex(parsed.questionIndex)) return null
    if (!isCategory(parsed.category)) return null
    if (!Array.isArray(parsed.questionIndices)) return null
    if (parsed.questionIndices.length < 1 || parsed.questionIndices.length > QUIZ_ROUNDS)
      return null
    if (!parsed.questionIndices.every(isQuestionIndex)) return null
    if (new Set(parsed.questionIndices).size !== parsed.questionIndices.length) return null
    if (parsed.questionIndices.at(-1) !== parsed.questionIndex) return null
    const answeredRounds = parsed.questionIndices.length - (parsed.lastAnswer === undefined ? 1 : 0)
    if (!isSessionCount(parsed.score) || parsed.score > answeredRounds) return null
    if (!isSessionCount(parsed.streak) || !isSessionCount(parsed.bestStreak)) return null
    if (parsed.streak > parsed.score || parsed.bestStreak < parsed.streak) return null
    if (parsed.bestStreak > parsed.score) return null
    if (typeof parsed.updatedAt !== 'number' || !Number.isFinite(parsed.updatedAt)) return null
    if (parsed.updatedAt > Date.now() || Date.now() - parsed.updatedAt > QUIZ_STATE_TTL_MS) {
      deleteStoredValue(stateKey(token))
      return null
    }
    if (parsed.lastAnswer !== undefined && !isAnswerIndex(parsed.lastAnswer)) return null
    if (parsed.correct !== undefined && typeof parsed.correct !== 'boolean') return null
    if ((parsed.lastAnswer === undefined) !== (parsed.correct === undefined)) return null
    if (
      parsed.lastAnswer !== undefined &&
      parsed.correct !== (parsed.lastAnswer === QUIZ_QUESTIONS[parsed.questionIndex]?.correct)
    ) {
      return null
    }
    if (parsed.correct === true && parsed.streak === 0) return null
    if (parsed.correct === false && parsed.streak !== 0) return null
    if (
      parsed.category !== 'mixed' &&
      parsed.questionIndices.some((index) => QUIZ_QUESTIONS[index]?.category !== parsed.category)
    ) {
      return null
    }

    return {
      commandInput: parsed.commandInput,
      pub: Boolean(parsed.pub),
      pubtab: Boolean(parsed.pubtab),
      category: parsed.category,
      questionIndex: parsed.questionIndex,
      questionIndices: parsed.questionIndices,
      chooser: parsed.chooser,
      score: parsed.score,
      streak: parsed.streak,
      bestStreak: parsed.bestStreak,
      updatedAt: parsed.updatedAt,
      lastAnswer: parsed.lastAnswer,
      correct: parsed.correct
    }
  } catch {
    return null
  }
}

function questionFromState(state: QuizState): QuizQuestion {
  return QUIZ_QUESTIONS[state.questionIndex] ?? QUIZ_QUESTIONS[0]
}

function isAnswerIndex(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value < 4
}

function parseAnswerId(customId: string): { token: string; round: number; answer: number } | null {
  const [base, token, roundRaw, answerRaw, extra] = customId.split(':')
  const round = Number.parseInt(roundRaw ?? '', 10)
  const answer = Number.parseInt(answerRaw ?? '', 10)
  if (
    base !== QUIZ_ANSWER_BUTTON_ID ||
    !token ||
    extra ||
    !Number.isInteger(round) ||
    round < 1 ||
    round > QUIZ_ROUNDS ||
    !isAnswerIndex(answer)
  ) {
    return null
  }
  return { token, round, answer }
}

function cleanupExpiredStates(): void {
  const now = Date.now()
  for (const key of listStoredKeys()) {
    if (!key.startsWith(`${QUIZ_STATE_KEY}:`)) continue
    const raw = getStoredValue(key)
    try {
      const state = raw ? (JSON.parse(raw) as Partial<QuizState>) : null
      if (
        !state ||
        typeof state.updatedAt !== 'number' ||
        state.updatedAt > now ||
        now - state.updatedAt > QUIZ_STATE_TTL_MS
      ) {
        deleteStoredValue(key)
      }
    } catch {
      deleteStoredValue(key)
    }
  }
}

function randomQuestionIndex(category: QuizCategory, excluded: readonly number[] = []): number {
  const available = QUIZ_QUESTIONS.flatMap((question, index) =>
    (category === 'mixed' || question.category === category) && !excluded.includes(index)
      ? [index]
      : []
  )
  return available[Math.floor(Math.random() * available.length)] ?? 0
}

function optionList(question: QuizQuestion): string[] {
  return question.answers.map((answer, index) => `${index + 1}) ${answer}`)
}

function statusLines(state: QuizState, question: QuizQuestion): string[] {
  const lines = [
    `Round **${state.questionIndices.length}/${QUIZ_ROUNDS}** | Score **${state.score}** | Streak **${state.streak}**`,
    `Category: ${question.category[0].toUpperCase()}${question.category.slice(1)}`,
    `Question: ${question.question}`,
    ...optionList(question).map((item) => `- ${item}`)
  ]

  if (!isAnswerIndex(state.lastAnswer)) {
    return [...lines, 'Pick one answer.']
  }

  const result = state.correct ? 'Correct!' : 'Not quite. Better luck next time.'
  const picked = question.answers[state.lastAnswer] ?? 'unknown'
  return [
    ...lines,
    `${state.chooser} chose "${picked}".`,
    `Correct answer: ${question.answers[question.correct]}.`,
    result,
    state.questionIndices.length === QUIZ_ROUNDS
      ? `Session complete: **${state.score}/${QUIZ_ROUNDS}** correct, best streak **${state.bestStreak}**.`
      : 'Continue when you are ready.'
  ]
}

function buildAnswerButton(
  token: string,
  index: number,
  answer: string,
  state: QuizState,
  question: QuizQuestion
): ButtonBuilder {
  const answered = isAnswerIndex(state.lastAnswer)
  const style = answered
    ? index === question.correct
      ? ButtonStyle.Success
      : index === state.lastAnswer
        ? ButtonStyle.Danger
        : ButtonStyle.Secondary
    : ButtonStyle.Primary

  return new ButtonBuilder()
    .setCustomId(`${QUIZ_ANSWER_BUTTON_ID}:${token}:${state.questionIndices.length}:${index}`)
    .setLabel(answer)
    .setStyle(style)
    .setDisabled(answered)
}

function buildAnswerRows(
  token: string,
  state: QuizState,
  question: QuizQuestion
): ActionRowBuilder<ButtonBuilder>[] {
  const top = new ActionRowBuilder<ButtonBuilder>().addComponents(
    buildAnswerButton(token, 0, question.answers[0], state, question),
    buildAnswerButton(token, 1, question.answers[1], state, question),
    buildAnswerButton(token, 2, question.answers[2], state, question)
  )

  const bottom = new ActionRowBuilder<ButtonBuilder>().addComponents(
    buildAnswerButton(token, 3, question.answers[3], state, question)
  )

  if (!isAnswerIndex(state.lastAnswer) || state.questionIndices.length === QUIZ_ROUNDS) {
    return [top, bottom]
  }

  const next = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`${QUIZ_NEXT_BUTTON_ID}:${token}:${state.questionIndices.length}`)
      .setLabel('Next question')
      .setStyle(ButtonStyle.Primary)
  )
  return [top, bottom, next]
}

function buildComponents(token: string, state: QuizState): GamePresentation {
  const question = questionFromState(state)
  const answered = isAnswerIndex(state.lastAnswer)
  const presentation = createGamePresentation({
    id: `quiz-${token}`,
    title: 'Quiz',
    kicker: answered
      ? state.questionIndices.length === QUIZ_ROUNDS
        ? 'Session complete'
        : state.correct
          ? 'Correct answer'
          : 'Round complete'
      : `Question ${state.questionIndices.length} of ${QUIZ_ROUNDS}`,
    lines: statusLines(state, question),
    footer: state.commandInput,
    visual: {
      kind: 'quiz',
      optionCount: question.answers.length,
      selected: answered ? state.lastAnswer : undefined,
      correct: answered ? question.correct : undefined
    },
    controls: buildAnswerRows(token, state, question)
  })
  presentation.components = withPubtabButton(presentation.components, state.pubtab)
  return presentation
}

function buildExpiredComponents(): GamePresentation {
  return createGamePresentation({
    id: 'quiz-expired',
    title: 'Quiz',
    kicker: 'Round unavailable',
    lines: ['Round expired. Start a new question with `quiz`.']
  })
}

export function isQuizAnswerButtonId(customId: string): boolean {
  return (
    customId.startsWith(`${QUIZ_ANSWER_BUTTON_ID}:`) ||
    customId.startsWith(`${QUIZ_NEXT_BUTTON_ID}:`)
  )
}

export async function handleQuizAnswerButton(interaction: ButtonInteraction): Promise<void> {
  if (interaction.customId.startsWith(`${QUIZ_NEXT_BUTTON_ID}:`)) {
    const [base, token, roundRaw, extra] = interaction.customId.split(':')
    const round = Number.parseInt(roundRaw ?? '', 10)
    const state = base === QUIZ_NEXT_BUTTON_ID && token && !extra ? loadState(token) : null
    if (
      !state ||
      round !== state.questionIndices.length ||
      !isAnswerIndex(state.lastAnswer) ||
      state.questionIndices.length >= QUIZ_ROUNDS
    ) {
      const expired = buildExpiredComponents()
      await interaction.reply({
        components: expired.components as never,
        files: expired.files,
        flags: [MessageFlags.IsComponentsV2, MessageFlags.Ephemeral]
      })
      return
    }

    state.questionIndex = randomQuestionIndex(state.category, state.questionIndices)
    state.questionIndices.push(state.questionIndex)
    state.lastAnswer = undefined
    state.correct = undefined
    storeState(token, state)

    const presentation = buildComponents(token, state)
    await interaction.update({
      components: presentation.components as never,
      files: presentation.files,
      attachments: [],
      flags: MessageFlags.IsComponentsV2
    })
    return
  }

  const parsed = parseAnswerId(interaction.customId)
  if (!parsed) {
    const expired = buildExpiredComponents()
    await interaction.reply({
      components: expired.components as never,
      files: expired.files,
      flags: [MessageFlags.IsComponentsV2, MessageFlags.Ephemeral]
    })
    return
  }

  const state = loadState(parsed.token)
  if (!state || parsed.round !== state.questionIndices.length) {
    const expired = buildExpiredComponents()
    await interaction.reply({
      components: expired.components as never,
      files: expired.files,
      flags: [MessageFlags.IsComponentsV2, MessageFlags.Ephemeral]
    })
    return
  }

  if (isAnswerIndex(state.lastAnswer)) {
    const presentation = buildComponents(parsed.token, state)
    await interaction.update({
      components: presentation.components as never,
      files: presentation.files,
      attachments: [],
      flags: MessageFlags.IsComponentsV2
    })
    return
  }

  state.lastAnswer = parsed.answer
  state.correct = parsed.answer === QUIZ_QUESTIONS[state.questionIndex]?.correct
  if (state.correct) {
    state.score++
    state.streak++
    state.bestStreak = Math.max(state.bestStreak, state.streak)
  } else {
    state.streak = 0
  }
  state.chooser = interaction.user.globalName ?? interaction.user.username

  storeState(parsed.token, state)

  const presentation = buildComponents(parsed.token, state)
  await interaction.update({
    components: presentation.components as never,
    files: presentation.files,
    attachments: [],
    flags: MessageFlags.IsComponentsV2
  })
}

export const subcommand: Subcommand = {
  name: 'quiz',
  description: 'five-question quiz challenge',
  usage: 'quiz [--category mixed|science|history|technology] [--pub]',
  examples: ['quiz', 'quiz --category science', 'quiz --category technology --pub'],
  pubtab: { label: 'Quiz', args: '' },
  flags: {
    category: { description: 'question category', value: 'string' }
  },

  async autocomplete(restArgs, flags) {
    if (!restArgs.includes(' ')) {
      void flags
      return [{ name: 'Quiz', value: 'quiz' }]
    }
    return []
  },

  async execute(interaction, args, flags) {
    cleanupExpiredStates()
    const categoryFlag = flags.get('category')
    const category = categoryFlag === undefined ? 'mixed' : String(categoryFlag).toLowerCase()
    if (!isCategory(category)) {
      await sendCommandReply(
        interaction,
        commandReferenceReply(
          subcommand,
          args,
          flags,
          'flags',
          `category must be one of: ${QUIZ_CATEGORIES.join(', ')}`
        )
      )
      return
    }

    const token = randomUUID().replace(/-/g, '').slice(0, 16)
    const questionIndex = randomQuestionIndex(category)
    const state: QuizState = {
      commandInput: args,
      pub: flags.has('pub'),
      pubtab: isPubtabContext(flags),
      category,
      chooser: interaction.user.globalName ?? interaction.user.username,
      questionIndex,
      questionIndices: [questionIndex],
      score: 0,
      streak: 0,
      bestStreak: 0,
      updatedAt: Date.now()
    }

    storeState(token, state)
    const presentation = buildComponents(token, state)

    if (interaction.deferred) {
      await interaction.editReply({
        components: presentation.components as never,
        files: presentation.files,
        attachments: [],
        flags: MessageFlags.IsComponentsV2
      })
      return
    }

    await interaction.reply({
      components: presentation.components as never,
      files: presentation.files,
      flags: state.pub
        ? ([MessageFlags.IsComponentsV2] as const)
        : ([MessageFlags.IsComponentsV2, MessageFlags.Ephemeral] as const)
    })
  }
}
