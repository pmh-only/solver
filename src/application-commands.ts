import { ApplicationCommandType, SlashCommandBuilder } from 'discord.js'
import { USER_IMAGES_COMMAND_NAME } from './commands/user-images.js'
import {
  MESSAGE_INTERACTION_JSON_COMMAND_NAME,
  USER_INTERACTION_JSON_COMMAND_NAME
} from './commands/interaction-json.js'
import {
  MESSAGE_RENDER_COMMAND_NAME,
  MESSAGE_THREAD_APPEND_COMMAND_NAME,
  MESSAGE_THREAD_START_COMMAND_NAME
} from './commands/message-render.js'
import { MESSAGE_STORE_COMMAND_NAME } from './commands/message-store.js'
import { AGENT_COMMAND_NAME, GPT_EFFORT_OPTIONS } from './commands/gpt.js'

export const solverCommand = new SlashCommandBuilder()
  .setName('c')
  .setDescription(':)')
  .addStringOption((option) =>
    option.setName('_').setDescription('sub').setRequired(true).setAutocomplete(true)
  )

export const agentCommand = new SlashCommandBuilder()
  .setName(AGENT_COMMAND_NAME)
  .setDescription('ask an AI agent')
  .addStringOption((option) =>
    option
      .setName('prompt')
      .setDescription('what to ask, or /clear to reset session')
      .setRequired(true)
  )
  .addStringOption((option) =>
    option.setName('session').setDescription('conversation session').setMaxLength(100)
  )
  .addStringOption((option) =>
    option.setName('model').setDescription('model for this session').setAutocomplete(true)
  )
  .addStringOption((option) =>
    option
      .setName('effort')
      .setDescription('reasoning effort for this session')
      .addChoices(...GPT_EFFORT_OPTIONS.map(({ id, label }) => ({ name: label, value: id })))
  )
  .addIntegerOption((option) =>
    option
      .setName('tokens')
      .setDescription('maximum output tokens for this session')
      .setMinValue(256)
      .setMaxValue(16384)
  )

export const applicationCommands = [
  {
    ...solverCommand.toJSON(),
    integration_types: [0, 1],
    contexts: [0, 1, 2]
  },
  {
    ...agentCommand.toJSON(),
    integration_types: [0, 1],
    contexts: [0, 1, 2]
  },
  {
    name: USER_IMAGES_COMMAND_NAME,
    type: ApplicationCommandType.User,
    integration_types: [0, 1],
    contexts: [0, 1, 2]
  },
  {
    name: USER_INTERACTION_JSON_COMMAND_NAME,
    type: ApplicationCommandType.User,
    integration_types: [0, 1],
    contexts: [0, 1, 2]
  },
  {
    name: MESSAGE_RENDER_COMMAND_NAME,
    type: ApplicationCommandType.Message,
    integration_types: [0, 1],
    contexts: [0, 1, 2]
  },
  {
    name: MESSAGE_THREAD_START_COMMAND_NAME,
    type: ApplicationCommandType.Message,
    integration_types: [0, 1],
    contexts: [0, 1, 2]
  },
  {
    name: MESSAGE_THREAD_APPEND_COMMAND_NAME,
    type: ApplicationCommandType.Message,
    integration_types: [0, 1],
    contexts: [0, 1, 2]
  },
  {
    name: MESSAGE_STORE_COMMAND_NAME,
    type: ApplicationCommandType.Message,
    integration_types: [0, 1],
    contexts: [0, 1, 2]
  },
  {
    name: MESSAGE_INTERACTION_JSON_COMMAND_NAME,
    type: ApplicationCommandType.Message,
    integration_types: [0, 1],
    contexts: [0, 1, 2]
  }
]

export function areApplicationCommandsCurrent(
  existing: Array<{
    name: string
    type: number
    description?: string
    options?: Array<{
      name: string
      type: number
      description: string
      required?: boolean
      autocomplete?: boolean
      max_length?: number
    }>
  }>
): boolean {
  if (existing.length !== applicationCommands.length) return false

  return applicationCommands.every((command) => {
    const type = command.type ?? ApplicationCommandType.ChatInput
    const registered = existing.find(
      (candidate) => candidate.name === command.name && candidate.type === type
    )
    if (!registered) return false

    if (command.name !== 'a' && command.name !== 'c') return true

    const desired = command as typeof registered
    const registeredOptions = registered.options ?? []
    const desiredOptions = desired.options ?? []
    return (
      registered.description === desired.description &&
      registeredOptions.length === desiredOptions.length &&
      desiredOptions.every((option, index) => {
        const current = registeredOptions[index]
        return (
          current?.name === option.name &&
          current.type === option.type &&
          current.description === option.description &&
          Boolean(current.required) === Boolean(option.required) &&
          Boolean(current.autocomplete) === Boolean(option.autocomplete) &&
          current.max_length === option.max_length
        )
      })
    )
  })
}
