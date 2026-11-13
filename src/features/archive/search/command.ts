import { MessageFlags, type Message } from 'discord.js'
import { loadCommunitySettings } from '../../community/settings.js'
import { generateArchiveSearchReply } from './ai.js'
import { archiveSearchError } from './error.js'
import { clearRuntimeIssue, reportRuntimeIssue } from '../../../shared/runtime/health.js'

const NO_MENTIONS = { parse: [] as const, repliedUser: false }
const USAGE = '찾을 내용을 입력해 주세요. 예: @검색역할 지난주에 피자 얘기한 메시지 찾아줘'

export function createArchiveSearchHandler(generate = generateArchiveSearchReply) {
  const users = new Map<string, { count: number; until: number; notified: boolean }>()
  let window = { until: 0, count: 0, notified: false }
  return async (message: Message): Promise<boolean> => {
    if (!message.guildId || message.author.bot || message.webhookId || message.system) return false
    let roleId: string | null
    try {
      const settings = loadCommunitySettings().discordArchive
      roleId = settings.enabled ? settings.searchRoleId : null
    } catch {
      return false
    }
    if (!roleId) return false
    const mention = new RegExp(`<(?:@&|&@)${roleId}>`, 'g')
    if (!mention.test(message.content)) return false
    mention.lastIndex = 0
    const reply = (content: string) =>
      message.reply({
        content: content.slice(0, 2000),
        allowedMentions: NO_MENTIONS,
        flags: MessageFlags.SuppressEmbeds
      })
    const now = Date.now()
    if (window.until <= now) {
      window = { until: now + 10_000, count: 0, notified: false }
      for (const [id, item] of users) if (item.until <= now) users.delete(id)
    }
    if (window.count++ >= 10) {
      if (!window.notified) {
        window.notified = true
        await reply('검색 요청이 많습니다. 잠시 후 다시 시도해 주세요.')
      }
      return true
    }
    const key = `${message.guildId}:${message.author.id}`
    let user = users.get(key)
    if (!user || user.until <= now) {
      user = { count: 0, until: now + 10_000, notified: false }
      if (users.size >= 2000) return true
      users.set(key, user)
    }
    if (user.count++ >= 3) {
      if (!user.notified) {
        user.notified = true
        await reply('검색은 10초에 3회까지 가능합니다. 잠시 후 다시 시도해 주세요.')
      }
      return true
    }
    const input = message.content.replace(mention, '').trim()
    if (!input || input.length > 4000) {
      await reply(USAGE)
      return true
    }
    try {
      if ('sendTyping' in message.channel) await message.channel.sendTyping().catch(() => {})
      await reply(
        await generate(input, {
          guildId: message.guildId,
          channelId: message.channelId,
          userId: message.author.id,
          requestMessageId: message.id
        })
      )
      clearRuntimeIssue('discord_archive_search')
    } catch (error) {
      const failure = archiveSearchError(error)
      reportRuntimeIssue(
        'discord_archive_search',
        new Error(`category=${failure.category}; status=${failure.status ?? 'unknown'}`)
      )
      await reply(failure.message)
    }
    return true
  }
}
