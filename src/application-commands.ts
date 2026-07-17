import {
  ApplicationCommandType,
  EntryPointCommandHandlerType,
  SlashCommandBuilder
} from 'discord.js'
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

export const solverCommand = new SlashCommandBuilder()
  .setName('c')
  .setDescription(':)')
  .addStringOption((option) =>
    option.setName('_').setDescription('sub').setRequired(true).setAutocomplete(true)
  )

export const ACTIVITY_ENTRY_COMMAND_NAME = 'Launch'

export const applicationCommands = [
  {
    ...solverCommand.toJSON(),
    integration_types: [0, 1],
    contexts: [0, 1, 2]
  },
  {
    name: ACTIVITY_ENTRY_COMMAND_NAME,
    description: 'Launch the Hello World Activity',
    type: ApplicationCommandType.PrimaryEntryPoint,
    handler: EntryPointCommandHandlerType.AppHandler,
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
  existing: Array<{ name: string; type: number; handler?: number | null }>
): boolean {
  return applicationCommands.every((command) => {
    const registered = existing.find(
      (candidate) => candidate.name === command.name && candidate.type === command.type
    )
    if (!registered) return false
    return !('handler' in command) || registered.handler === command.handler
  })
}
