import { ApplicationCommandType, SlashCommandBuilder } from 'discord.js'
import type { ApplicationCommandDefinition } from './feature-registry.js'
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
import { agentCommand } from './agent/command.js'

export { agentCommand } from './agent/command.js'

export const solverCommand = new SlashCommandBuilder()
  .setName('c')
  .setDescription(':)')
  .addStringOption((option) =>
    option.setName('_').setDescription('sub').setRequired(true).setAutocomplete(true)
  )

export const agentApplicationCommands = [
  {
    ...agentCommand.toJSON(),
    integration_types: [0, 1],
    contexts: [0, 1, 2]
  }
]

export const additionalApplicationCommands = [
  {
    ...solverCommand.toJSON(),
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

export const applicationCommands = [...agentApplicationCommands, ...additionalApplicationCommands]

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
  }>,
  desiredCommands: readonly ApplicationCommandDefinition[] = applicationCommands
): boolean {
  if (existing.length !== desiredCommands.length) return false

  return desiredCommands.every((command) => {
    const type = command.type ?? ApplicationCommandType.ChatInput
    const registered = existing.find(
      (candidate) => candidate.name === command.name && candidate.type === type
    )
    if (!registered) return false

    const desired = command as typeof registered
    if (desired.description === undefined && desired.options === undefined) return true

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
