import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ContainerBuilder,
  MessageFlags,
  SeparatorBuilder,
  SeparatorSpacingSize,
  TextDisplayBuilder,
  type ButtonInteraction
} from 'discord.js'
import { randomUUID } from 'node:crypto'
import type { Subcommand } from '../types.js'
import { getStoredValue, setStoredValue } from '../helpers/kv-store.js'
import { isPubtabContext } from '../flags.js'
import { withPubtabButton } from '../components.js'

export const QUIZ_ANSWER_BUTTON_ID = 'quiz-answer'

const QUIZ_COLOR = 0xdb2777
const QUIZ_STATE_KEY = 'quiz'

const QUIZ_QUESTIONS = [
  {
    question: 'What is 2 + 2?',
    answers: ['1', '3', '4', '5'],
    correct: 2
  },
  {
    question: 'Which planet is known as the Red Planet?',
    answers: ['Earth', 'Mars', 'Venus', 'Jupiter'],
    correct: 1
  },
  {
    question: 'How many letters are in the word "cat"?',
    answers: ['3', '2', '4', '1'],
    correct: 0
  },
  {
    question: 'What is the first digit of pi?',
    answers: ['2', '1', '3', '0'],
    correct: 2
  }
] as const

type QuizQuestion = (typeof QUIZ_QUESTIONS)[number]

interface QuizState {
  commandInput: string
  pub: boolean
  pubtab: boolean
  questionIndex: number
  chooser: string
  lastAnswer?: number
  correct?: boolean
}

type QuizComponent = ContainerBuilder | ActionRowBuilder<ButtonBuilder>

function stateKey(token: string): string {
  return `${QUIZ_STATE_KEY}:${token}`
}

function storeState(token: string, state: QuizState): void {
  setStoredValue(stateKey(token), JSON.stringify(state))
}

function isQuestionIndex(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value < QUIZ_QUESTIONS.length
}

function loadState(token: string): QuizState | null {
  const stored = getStoredValue(stateKey(token))
  if (!stored) return null

  try {
    const parsed = JSON.parse(stored) as Partial<QuizState>
    if (typeof parsed.commandInput !== 'string' || !parsed.commandInput) return null
    if (typeof parsed.chooser !== 'string' || !parsed.chooser) return null
    if (!isQuestionIndex(parsed.questionIndex)) return null

    return {
      commandInput: parsed.commandInput,
      pub: Boolean(parsed.pub),
      pubtab: Boolean(parsed.pubtab),
      questionIndex: parsed.questionIndex,
      chooser: parsed.chooser,
      lastAnswer: Number.isInteger(parsed.lastAnswer) ? (parsed.lastAnswer as number) : undefined,
      correct: Boolean(parsed.correct)
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

function parseAnswerId(customId: string): { token: string; answer: number } | null {
  const [base, token, answerRaw] = customId.split(':')
  const answer = Number.parseInt(answerRaw ?? '', 10)
  if (base !== QUIZ_ANSWER_BUTTON_ID || !token || !isAnswerIndex(answer)) return null
  return { token, answer }
}

function randomQuestionIndex(): number {
  return Math.floor(Math.random() * QUIZ_QUESTIONS.length)
}

function optionList(question: QuizQuestion): string[] {
  return question.answers.map((answer, index) => `${index + 1}) ${answer}`)
}

function statusLines(state: QuizState, question: QuizQuestion): string[] {
  const lines = [`Question: ${question.question}`, ...optionList(question).map((item) => `- ${item}`)]

  if (!isAnswerIndex(state.lastAnswer)) {
    return [...lines, 'Pick one answer and test your luck.']
  }

  const result = state.correct ? 'Correct!' : 'Not quite. Better luck next time.'
  const picked = question.answers[state.lastAnswer] ?? 'unknown'
  return [
    ...lines,
    `${state.chooser} chose "${picked}".`,
    `Correct answer: ${question.answers[question.correct]}.`,
    result
  ]
}

function buildAnswerButton(token: string, index: number, answer: string, disabled: boolean): ButtonBuilder {
  return new ButtonBuilder()
    .setCustomId(`${QUIZ_ANSWER_BUTTON_ID}:${token}:${index}`)
    .setLabel(answer)
    .setStyle(ButtonStyle.Primary)
    .setDisabled(disabled)
}

function buildAnswerRows(token: string, state: QuizState, question: QuizQuestion): ActionRowBuilder<ButtonBuilder>[] {
  const disabled = isAnswerIndex(state.lastAnswer)

  const top = new ActionRowBuilder<ButtonBuilder>()
    .addComponents(
      buildAnswerButton(token, 0, question.answers[0], disabled),
      buildAnswerButton(token, 1, question.answers[1], disabled),
      buildAnswerButton(token, 2, question.answers[2], disabled)
    )

  const bottom = new ActionRowBuilder<ButtonBuilder>()
    .addComponents(
      buildAnswerButton(token, 3, question.answers[3], disabled)
    )

  return [top, bottom]
}

function buildComponents(token: string, state: QuizState): QuizComponent[] {
  const question = questionFromState(state)
  const container = new ContainerBuilder()
    .setAccentColor(QUIZ_COLOR)
    .addTextDisplayComponents(new TextDisplayBuilder().setContent(`# Quiz\n${statusLines(state, question).join('\n')}`))
    .addSeparatorComponents(new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small).setDivider(true))
    .addTextDisplayComponents(new TextDisplayBuilder().setContent(`-# \`${state.commandInput}\``))

  return withPubtabButton([container, ...buildAnswerRows(token, state, question)], state.pubtab)
}

function buildExpiredComponents(): QuizComponent[] {
  return [
    new ContainerBuilder()
      .setAccentColor(QUIZ_COLOR)
      .addTextDisplayComponents(new TextDisplayBuilder().setContent('# Quiz\nGame expired.'))
  ]
}

export function isQuizAnswerButtonId(customId: string): boolean {
  return customId.startsWith(`${QUIZ_ANSWER_BUTTON_ID}:`)
}

export async function handleQuizAnswerButton(interaction: ButtonInteraction): Promise<void> {
  const parsed = parseAnswerId(interaction.customId)
  if (!parsed) {
    await interaction.reply({
      components: buildExpiredComponents() as never,
      flags: [MessageFlags.IsComponentsV2, MessageFlags.Ephemeral]
    })
    return
  }

  const state = loadState(parsed.token)
  if (!state) {
    await interaction.reply({
      components: buildExpiredComponents() as never,
      flags: [MessageFlags.IsComponentsV2, MessageFlags.Ephemeral]
    })
    return
  }

  state.lastAnswer = parsed.answer
  state.correct = parsed.answer === QUIZ_QUESTIONS[state.questionIndex]?.correct
  state.chooser = interaction.user.globalName ?? interaction.user.username

  storeState(parsed.token, state)

  await interaction.update({
    components: buildComponents(parsed.token, state) as never,
    flags: MessageFlags.IsComponentsV2
  })
}

export const subcommand: Subcommand = {
  name: 'quiz',
  description: 'tiny quiz challenge',
  usage: 'quiz [--pub]',
  examples: ['quiz', 'quiz --pub'],
  pubtab: { label: 'Quiz', args: '' },

  async autocomplete(restArgs, flags) {
    if (!restArgs.includes(' ')) {
      void flags
      return [{ name: 'Quiz', value: 'quiz' }]
    }
    return []
  },

  async execute(interaction, args, flags) {
    const token = randomUUID().replace(/-/g, '').slice(0, 16)
    const state: QuizState = {
      commandInput: args,
      pub: flags.has('pub'),
      pubtab: isPubtabContext(flags),
      chooser: interaction.user.globalName ?? interaction.user.username,
      questionIndex: randomQuestionIndex()
    }

    storeState(token, state)
    const components = buildComponents(token, state)

    if (interaction.deferred) {
      await interaction.editReply({
        components: components as never,
        flags: MessageFlags.IsComponentsV2
      })
      return
    }

    await interaction.reply({
      components: components as never,
      flags: state.pub
        ? ([MessageFlags.IsComponentsV2] as const)
        : ([MessageFlags.IsComponentsV2, MessageFlags.Ephemeral] as const)
    })
  }
}
