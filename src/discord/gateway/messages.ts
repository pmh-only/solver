import type { Message } from 'discord.js'
import { createMessageBotHandler } from '../../features/messages/bot/runtime.js'
import { createRoleChatHandler } from '../../features/conversation/role-chat.js'
import { createArchiveSearchHandler } from '../../features/archive/search/command.js'
import { createMemeSearchHandler } from '../../features/memes/search.js'
import { createRepeatedMessageHandler } from '../../features/messages/repeated.js'

export function createMessageHandler(
  handleCommands = createMessageBotHandler(),
  handleRoleChat = createRoleChatHandler(),
  handleSearch = createArchiveSearchHandler(),
  handleMemeSearch = createMemeSearchHandler(),
  handleRepeatedMessages = createRepeatedMessageHandler()
) {
  return async (message: Message): Promise<void> => {
    await handleRepeatedMessages(message)
    if (await handleCommands(message)) return
    if (await handleMemeSearch(message)) return
    if (await handleSearch(message)) return
    await handleRoleChat(message)
  }
}
