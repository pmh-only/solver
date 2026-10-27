import type { Message } from 'discord.js'
import { createMessageBotHandler } from './commands/message-bot/runtime.js'
import { createRoleChatHandler } from './role-chat.js'

export function createMessageHandler(
  handleCommands = createMessageBotHandler(),
  handleRoleChat = createRoleChatHandler()
) {
  return async (message: Message): Promise<void> => {
    if (await handleCommands(message)) return
    await handleRoleChat(message)
  }
}
