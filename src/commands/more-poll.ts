import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonInteraction,
  ButtonStyle,
  MessageFlags
} from 'discord.js'
import { randomUUID } from 'node:crypto'
import { getStoredValue, setStoredValue } from '../helpers/kv-store.js'
import type { Subcommand } from '../types.js'
import { commandReferenceReply, container, sendCommandReply } from '../components.js'
import { createGamePresentation } from '../canvas-presentation.js'

export const POLL_BUTTON_ID = 'poll-vote'
const POLL_PREFIX = 'poll:'

interface PollState {
  question: string
  options: string[]
  votes: Record<string, number>
}

function savePoll(token: string, state: PollState) {
  setStoredValue(`${POLL_PREFIX}${token}`, JSON.stringify(state))
}

function loadPoll(token: string): PollState | null {
  const stored = getStoredValue(`${POLL_PREFIX}${token}`)
  if (!stored) return null
  try {
    const parsed = JSON.parse(stored) as Partial<PollState>
    if (!parsed.question || !Array.isArray(parsed.options) || !parsed.votes) return null
    return {
      question: parsed.question,
      options: parsed.options.filter((option): option is string => typeof option === 'string'),
      votes: Object.fromEntries(
        Object.entries(parsed.votes).filter(
          (entry): entry is [string, number] => typeof entry[1] === 'number'
        )
      )
    }
  } catch {
    return null
  }
}

function pollComponents(token: string, state: PollState) {
  const counts = state.options.map(
    (_, index) => Object.values(state.votes).filter((vote) => vote === index).length
  )
  const total = counts.reduce((sum, count) => sum + count, 0)
  const lines = state.options.map((option, index) => {
    const pct = total === 0 ? 0 : Math.round((counts[index] / total) * 100)
    return `${index + 1}. ${option} - ${counts[index]} vote${counts[index] === 1 ? '' : 's'} (${pct}%)`
  })

  const rows: ActionRowBuilder<ButtonBuilder>[] = []
  for (let offset = 0; offset < state.options.length; offset += 5) {
    rows.push(
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        state.options.slice(offset, offset + 5).map((option, localIndex) =>
          new ButtonBuilder()
            .setCustomId(`${POLL_BUTTON_ID}:${token}:${offset + localIndex}`)
            .setLabel(`${offset + localIndex + 1}. ${option}`.slice(0, 80))
            .setStyle(ButtonStyle.Secondary)
        )
      )
    )
  }

  return createGamePresentation({
    id: `poll-${token}`,
    title: state.question,
    kicker: `${total} total vote${total === 1 ? '' : 's'}`,
    lines,
    visual: {
      kind: 'poll',
      options: state.options.map((_, index) => ({
        percent: total === 0 ? 0 : Math.round((counts[index] / total) * 100)
      }))
    },
    controls: rows
  })
}

export function isPollButtonId(customId: string): boolean {
  return customId.startsWith(`${POLL_BUTTON_ID}:`)
}

export async function handlePollButton(interaction: ButtonInteraction): Promise<void> {
  const [, token, indexRaw] = interaction.customId.split(':')
  const index = Number.parseInt(indexRaw ?? '', 10)
  if (!token || !Number.isInteger(index)) {
    await sendCommandReply(interaction, container('poll', new Map(), 'bad poll'))
    return
  }

  const state = loadPoll(token)
  if (!state || index < 0 || index >= state.options.length) {
    await sendCommandReply(interaction, container('poll', new Map(), 'poll expired'))
    return
  }

  state.votes[interaction.user.id] = index
  savePoll(token, state)
  const presentation = pollComponents(token, state)
  await interaction.update({
    components: presentation.components as never,
    files: presentation.files,
    attachments: [],
    flags: MessageFlags.IsComponentsV2
  })
}

export const poll: Subcommand = {
  name: 'poll',
  description: 'button poll',
  usage: 'poll <question> | <option> | <option> [--pub]',
  examples: ['poll Lunch? | ramen | sushi | pizza --pub'],
  async execute(interaction, args, flags) {
    const parts = args
      .replace(/^\S+\s*/, '')
      .split('|')
      .map((part) => part.trim())
      .filter(Boolean)

    if (parts.length < 3) {
      await sendCommandReply(
        interaction,
        commandReferenceReply(poll, args, flags, 'usage', 'need question and two options')
      )
      return
    }

    const state: PollState = {
      question: parts[0] ?? 'Poll',
      options: parts.slice(1, 11),
      votes: {}
    }
    const token = randomUUID().replace(/-/g, '').slice(0, 12)
    savePoll(token, state)
    const presentation = pollComponents(token, state)
    await interaction.reply({
      components: presentation.components as never,
      files: presentation.files,
      flags: MessageFlags.IsComponentsV2
    })
  }
}
