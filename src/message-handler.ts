import type { Message } from 'discord.js'
import { createMessageBotHandler } from './commands/message-bot/runtime.js'
import { createRoleChatHandler } from './role-chat.js'
import { createArchiveSearchHandler } from './archive-search.js'
import { createMemeSearchHandler } from './meme-search.js'

export function createMessageHandler(
  handleCommands = createMessageBotHandler(),
  handleRoleChat = createRoleChatHandler(),
  handleSearch = createArchiveSearchHandler(),
  handleMemeSearch = createMemeSearchHandler()
) {
  return async (message: Message): Promise<void> => {
    if (await handleCommands(message)) return
    if (await handleMemeSearch(message)) return
    if (await handleSearch(message)) return
    await handleRoleChat(message)
  }
}
