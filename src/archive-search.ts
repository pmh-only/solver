import { escapeMarkdown, MessageFlags, type Message } from 'discord.js'
import { loadCommunitySettings } from './community-settings.js'
import {
  searchDiscordArchive,
  type ArchiveSearchRequest,
  type ArchiveSearchResult
} from './discord-archive.js'

const NO_MENTIONS = { parse: [] as const, repliedUser: false }
const USAGE =
  '검색어를 하나 지정해 주세요. 예: @검색역할 임베드나 컨텐츠에 "바나나" 들어가는 내용 찾아줘'
export function parseArchiveSearch(
  input: string
): { keyword: string; scope: ArchiveSearchRequest['scope'] } | null {
  const quoted = [...input.matchAll(/"([^"\r\n]*)"|'([^'\r\n]*)'|“([^”\r\n]*)”|「([^」\r\n]*)」/g)]
  if (quoted.length > 1) return null
  const keyword = (
    quoted[0]?.slice(1).find((part) => part !== undefined) ??
    (/^[^\s"'“”「」]+$/.test(input.trim()) ? input.trim() : '')
  ).trim()
  if (!keyword || keyword.length > 200) return null
  if (!quoted.length && /^(?:찾아줘|찾아봐|검색|검색해줘|find|search)$/i.test(keyword)) return null
  const directive = quoted[0] ? input.replace(quoted[0][0], '') : ''
  const content = /본문|컨텐츠|콘텐츠|content/i.test(directive)
  const embeds = /임베드|embed/i.test(directive)
  return { keyword, scope: content === embeds ? 'all' : embeds ? 'embeds' : 'content' }
}

function safeText(value: string, length: number) {
  return escapeMarkdown(value.replace(/\s+/g, ' ').trim().slice(0, length))
    .replace(/[[\]]/g, '\\$&')
    .replace(/@/g, '@\u200b')
}

export function createArchiveSearchHandler(search = searchDiscordArchive) {
  const users = new Map<string, { count: number; until: number; notified: boolean }>()
  let window = { until: 0, count: 0, notified: false }
  let active = false
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
    const parsed = input.length <= 4000 ? parseArchiveSearch(input) : null
    if (!parsed) {
      await reply(USAGE)
      return true
    }
    if (active) {
      await reply('다른 검색이 진행 중입니다. 잠시 후 다시 시도해 주세요.')
      return true
    }
    active = true
    try {
      if ('sendTyping' in message.channel) await message.channel.sendTyping().catch(() => {})
      const result: ArchiveSearchResult = await search({
        guildId: message.guildId,
        channelId: message.channelId,
        userId: message.author.id,
        requestMessageId: message.id,
        ...parsed
      })
      let body = `**아카이브 검색**\n검색어: ${safeText(parsed.keyword, 200)} · 현재 채널의 ${parsed.scope === 'all' ? '본문·임베드' : parsed.scope === 'content' ? '본문' : '임베드'}\n`
      if (!result.matches.length) body += '\n현재 원문에서 확인 가능한 검색 결과가 없습니다.\n'
      for (const item of result.matches.slice(0, 5)) {
        if (!/^\d{17,20}$/.test(item.id)) continue
        const line = `\n[원문](https://discord.com/channels/${message.guildId}/${message.channelId}/${item.id}) · ${safeText(item.authorName, 40)} · ${item.field === 'content' ? '본문' : '임베드'}\n> ${safeText(item.snippet, 180)}\n`
        if (body.length + line.length > 1830) break
        body += line
      }
      if (result.more) body += '\n-# 추가 결과는 검색어를 구체화해 확인하세요.'
      if (!result.historyComplete)
        body += '\n-# 과거 기록 수집이 완료되지 않아 일부 결과가 빠질 수 있습니다.'
      if (result.pendingEvents) body += '\n-# 실시간 반영을 기다리는 메시지가 있습니다.'
      await reply(body)
    } catch (error) {
      const detail = error instanceof Error ? error.message : ''
      const message = detail.includes('No archive exists')
        ? '이 채널의 아카이브가 없습니다. 관리자가 /a에서 채널 수집을 시작해야 합니다.'
        : /permission|History|members|administrator/i.test(detail)
          ? '채널 보기·메시지 기록 읽기 권한을 확인해 주세요.'
          : detail.includes('busy')
            ? '아카이브 수집이나 조회가 진행 중입니다. 잠시 후 다시 시도해 주세요.'
            : '지금은 검색을 완료할 수 없습니다. 잠시 후 다시 시도해 주세요.'
      await reply(message)
    } finally {
      active = false
    }
    return true
  }
}
