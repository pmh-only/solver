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
  releaseStoredLease,
  setStoredValue,
  tryAcquireStoredLease
} from '../helpers/kv-store.js'
import { isPubtabContext } from '../flags.js'
import { commandReferenceReply, sendCommandReply, withPubtabButton } from '../components.js'
import { createGamePresentation, type GamePresentation } from '../canvas-presentation.js'
import {
  generateQuizQuestion,
  QUIZ_CATEGORIES,
  type QuizCategory,
  type QuizQuestion
} from './quiz-runtime.js'

export const QUIZ_ANSWER_BUTTON_ID = 'quiz-answer'
export const QUIZ_NEXT_BUTTON_ID = 'quiz-next'

const QUIZ_STATE_KEY = '__quiz-state'
const QUIZ_STATE_TTL_MS = 60 * 60 * 1000
const QUIZ_GENERATION_LEASE_TTL_MS = 30_000
const QUIZ_ROUNDS = 5
const activeGenerations = new Set<string>()

interface QuizState {
  commandInput: string
  pub: boolean
  pubtab: boolean
  category: QuizCategory
  locale: string
  question: QuizQuestion
  previousQuestions: string[]
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

function isCategory(value: unknown): value is QuizCategory {
  return QUIZ_CATEGORIES.some((category) => category === value)
}

function isQuestion(value: unknown): value is QuizQuestion {
  if (!value || typeof value !== 'object') return false
  const question = value as Partial<QuizQuestion>
  return (
    typeof question.question === 'string' &&
    question.question.trim().length > 0 &&
    question.question.length <= 200 &&
    Array.isArray(question.answers) &&
    question.answers.length === 4 &&
    question.answers.every(
      (answer) => typeof answer === 'string' && answer.trim().length > 0 && answer.length <= 80
    ) &&
    new Set(question.answers.map((answer) => answer.trim().toLocaleLowerCase('en-US'))).size ===
      4 &&
    isAnswerIndex(question.correct) &&
    (question.category === 'science' ||
      question.category === 'history' ||
      question.category === 'technology')
  )
}

function normalizeQuestion(value: string): string {
  return value.trim().replace(/\s+/g, ' ').toLocaleLowerCase('en-US')
}

function escapeMarkdown(value: string): string {
  return value.replace(/([\\`*_[\]])/g, '\\$1').replaceAll('@', '@\u200b')
}

function safeFooter(value: string): string {
  return value
    .replace(/[\r\n]+/g, ' ')
    .replaceAll('`', "'")
    .replaceAll('@', '@\u200b')
}

function isSessionCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= QUIZ_ROUNDS
}

function loadState(token: string): QuizState | null {
  const stored = getStoredValue(stateKey(token))
  if (!stored) return null

  try {
    const parsed = JSON.parse(stored) as Partial<QuizState>
    if (
      typeof parsed.commandInput !== 'string' ||
      !parsed.commandInput ||
      parsed.commandInput.length > 500
    ) {
      return null
    }
    if (typeof parsed.chooser !== 'string' || !parsed.chooser || parsed.chooser.length > 100) {
      return null
    }
    if (typeof parsed.pub !== 'boolean' || typeof parsed.pubtab !== 'boolean') return null
    if (!isCategory(parsed.category)) return null
    if (typeof parsed.locale !== 'string' || !parsed.locale || parsed.locale.length > 32)
      return null
    if (!isQuestion(parsed.question)) return null
    if (!Array.isArray(parsed.previousQuestions)) return null
    if (parsed.previousQuestions.length < 1 || parsed.previousQuestions.length > QUIZ_ROUNDS)
      return null
    if (
      !parsed.previousQuestions.every(
        (question) => typeof question === 'string' && question.length > 0 && question.length <= 200
      )
    ) {
      return null
    }
    const normalizedQuestions = parsed.previousQuestions.map(normalizeQuestion)
    if (new Set(normalizedQuestions).size !== normalizedQuestions.length) return null
    if (normalizedQuestions.at(-1) !== normalizeQuestion(parsed.question.question)) return null
    const answeredRounds =
      parsed.previousQuestions.length - (parsed.lastAnswer === undefined ? 1 : 0)
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
      parsed.correct !== (parsed.lastAnswer === parsed.question.correct)
    ) {
      return null
    }
    if (parsed.correct === true && parsed.streak === 0) return null
    if (parsed.correct === false && parsed.streak !== 0) return null
    if (parsed.category !== 'mixed' && parsed.question.category !== parsed.category) {
      return null
    }

    return {
      commandInput: parsed.commandInput,
      pub: parsed.pub,
      pubtab: parsed.pubtab,
      category: parsed.category,
      locale: parsed.locale,
      question: parsed.question,
      previousQuestions: parsed.previousQuestions,
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

function optionList(question: QuizQuestion): string[] {
  return question.answers.map((answer, index) => `${index + 1}) ${escapeMarkdown(answer)}`)
}

function statusLines(state: QuizState, question: QuizQuestion): string[] {
  const lines = [
    `Round **${state.previousQuestions.length}/${QUIZ_ROUNDS}** | Score **${state.score}** | Streak **${state.streak}**`,
    `Category: ${question.category[0].toUpperCase()}${question.category.slice(1)}`,
    `Question: ${escapeMarkdown(question.question)}`,
    ...optionList(question).map((item) => `- ${item}`)
  ]

  if (!isAnswerIndex(state.lastAnswer)) {
    return [...lines, 'Pick one answer.']
  }

  const result = state.correct ? 'Correct!' : 'Not quite. Better luck next time.'
  const picked = question.answers[state.lastAnswer] ?? 'unknown'
  return [
    ...lines,
    `${escapeMarkdown(state.chooser)} chose "${escapeMarkdown(picked)}".`,
    `Correct answer: ${escapeMarkdown(question.answers[question.correct])}.`,
    result,
    state.previousQuestions.length === QUIZ_ROUNDS
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
    .setCustomId(`${QUIZ_ANSWER_BUTTON_ID}:${token}:${state.previousQuestions.length}:${index}`)
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

  if (!isAnswerIndex(state.lastAnswer) || state.previousQuestions.length === QUIZ_ROUNDS) {
    return [top, bottom]
  }

  const next = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`${QUIZ_NEXT_BUTTON_ID}:${token}:${state.previousQuestions.length}`)
      .setLabel('Next question')
      .setStyle(ButtonStyle.Primary)
  )
  return [top, bottom, next]
}

function buildComponents(
  token: string,
  state: QuizState,
  generationError?: string
): GamePresentation {
  const question = state.question
  const answered = isAnswerIndex(state.lastAnswer)
  const presentation = createGamePresentation({
    id: `quiz-${token}`,
    title: 'Quiz',
    kicker: answered
      ? state.previousQuestions.length === QUIZ_ROUNDS
        ? 'Session complete'
        : state.correct
          ? 'Correct answer'
          : 'Round complete'
      : `Question ${state.previousQuestions.length} of ${QUIZ_ROUNDS}`,
    lines: [
      ...statusLines(state, question),
      ...(generationError ? [`Generation error: ${generationError}`] : [])
    ],
    footer: safeFooter(state.commandInput),
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

function buildGenerationUnavailableComponents(
  commandInput: string,
  pubtab: boolean
): GamePresentation {
  const presentation = createGamePresentation({
    id: 'quiz-generation-unavailable',
    title: 'Quiz',
    kicker: 'Question unavailable',
    lines: ['GPT could not generate a question. Try `quiz` again in a moment.'],
    footer: safeFooter(commandInput)
  })
  presentation.components = withPubtabButton(presentation.components, pubtab)
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
      round !== state.previousQuestions.length ||
      !isAnswerIndex(state.lastAnswer) ||
      state.previousQuestions.length >= QUIZ_ROUNDS
    ) {
      const expired = buildExpiredComponents()
      await interaction.reply({
        components: expired.components as never,
        files: expired.files,
        flags: [MessageFlags.IsComponentsV2, MessageFlags.Ephemeral]
      })
      return
    }

    if (activeGenerations.has(token)) {
      const presentation = buildComponents(token, state, 'A question is already being generated.')
      await interaction.reply({
        components: presentation.components as never,
        files: presentation.files,
        flags: [MessageFlags.IsComponentsV2, MessageFlags.Ephemeral]
      })
      return
    }

    const leaseKey = `__quiz-generation:session:${token}`
    const leaseOwner = randomUUID()
    let leaseAcquired = false
    try {
      leaseAcquired = tryAcquireStoredLease(leaseKey, leaseOwner, QUIZ_GENERATION_LEASE_TTL_MS)
    } catch {
      // Treat database contention like another active generator so the interaction is answered.
    }
    if (!leaseAcquired) {
      const presentation = buildComponents(token, state, 'A question is already being generated.')
      await interaction.reply({
        components: presentation.components as never,
        files: presentation.files,
        flags: [MessageFlags.IsComponentsV2, MessageFlags.Ephemeral]
      })
      return
    }

    activeGenerations.add(token)
    try {
      await interaction.deferUpdate()
      let question: QuizQuestion
      try {
        question = await generateQuizQuestion({
          category: state.category,
          locale: state.locale,
          previousQuestions: state.previousQuestions,
          userId: interaction.user.id
        })
      } catch {
        const current = loadState(token) ?? state
        const presentation = buildComponents(
          token,
          current,
          'Could not create the next question. Use Next question to retry.'
        )
        await interaction.editReply({
          components: presentation.components as never,
          files: presentation.files,
          attachments: [],
          flags: MessageFlags.IsComponentsV2
        })
        return
      }

      const current = loadState(token)
      if (
        !current ||
        round !== current.previousQuestions.length ||
        !isAnswerIndex(current.lastAnswer)
      ) {
        const expired = buildExpiredComponents()
        await interaction.editReply({
          components: expired.components as never,
          files: expired.files,
          attachments: [],
          flags: MessageFlags.IsComponentsV2
        })
        return
      }

      const advanced: QuizState = {
        ...current,
        question,
        previousQuestions: [...current.previousQuestions, question.question],
        lastAnswer: undefined,
        correct: undefined
      }
      storeState(token, advanced)

      const presentation = buildComponents(token, advanced)
      try {
        await interaction.editReply({
          components: presentation.components as never,
          files: presentation.files,
          attachments: [],
          flags: MessageFlags.IsComponentsV2
        })
      } catch {
        storeState(token, state)
        const retry = buildComponents(
          token,
          state,
          'Could not display the next question. Use Next question to retry.'
        )
        await interaction.editReply({
          components: retry.components as never,
          files: retry.files,
          attachments: [],
          flags: MessageFlags.IsComponentsV2
        })
      }
    } finally {
      activeGenerations.delete(token)
      try {
        releaseStoredLease(leaseKey, leaseOwner)
      } catch {
        // The short lease expires by itself if the database remains busy.
      }
    }
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
  if (!state || parsed.round !== state.previousQuestions.length) {
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
  state.correct = parsed.answer === state.question.correct
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
  description: 'AI-generated five-question quiz challenge',
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
    if (args.length > 500) {
      await sendCommandReply(
        interaction,
        commandReferenceReply(subcommand, args.slice(0, 500), flags, 'usage', 'command is too long')
      )
      return
    }
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
    const pub = flags.has('pub')
    const pubtab = isPubtabContext(flags)
    if (!interaction.deferred) {
      await interaction.deferReply({ flags: pub ? undefined : MessageFlags.Ephemeral })
    }

    let question: QuizQuestion
    try {
      question = await generateQuizQuestion({
        category,
        locale: interaction.locale || 'en-US',
        previousQuestions: [],
        userId: interaction.user.id
      })
    } catch {
      const unavailable = buildGenerationUnavailableComponents(args, pubtab)
      await interaction.editReply({
        components: unavailable.components as never,
        files: unavailable.files,
        attachments: [],
        flags: MessageFlags.IsComponentsV2
      })
      return
    }

    const state: QuizState = {
      commandInput: args,
      pub,
      pubtab,
      category,
      locale: interaction.locale || 'en-US',
      question,
      previousQuestions: [question.question],
      chooser: interaction.user.globalName ?? interaction.user.username,
      score: 0,
      streak: 0,
      bestStreak: 0,
      updatedAt: Date.now()
    }

    storeState(token, state)
    const presentation = buildComponents(token, state)

    await interaction.editReply({
      components: presentation.components as never,
      files: presentation.files,
      attachments: [],
      flags: MessageFlags.IsComponentsV2
    })
  }
}
