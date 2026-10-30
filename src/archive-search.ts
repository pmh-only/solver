import { escapeMarkdown, MessageFlags, type Message } from 'discord.js'
import { loadCommunitySettings } from './community-settings.js'
import { ArchiveQueryError, prepareArchiveSearch } from './archive-search-query.js'
import { clearRuntimeIssue, reportRuntimeIssue } from './runtime-health.js'
import { searchDiscordArchive, type ArchiveSearchResult } from './discord-archive.js'

const NO_MENTIONS = { parse: [] as const, repliedUser: false }
const USAGE =
  '검색식을 입력해 주세요. 예: @검색역할 털 AND (고양이 OR 강아지) · "정확한 구문"은 필수 · -제외 · 바나냐~1 · 고양*'

function safeText(value: string, length: number) {
  return escapeMarkdown(value.replace(/\s+/g, ' ').trim().slice(0, length))
    .replace(/[[\]]/g, '\\$&')
    .replace(/@/g, '@\u200b')
}

export function createArchiveSearchHandler(
  search = searchDiscordArchive,
  interpret = prepareArchiveSearch
) {
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
    if (!input || input.length > 4000) {
      await reply(USAGE)
      return true
    }
    if (active) {
      await reply('다른 검색이 진행 중입니다. 잠시 후 다시 시도해 주세요.')
      return true
    }
    active = true
    let stage: 'interpret' | 'search' = 'interpret'
    try {
      if ('sendTyping' in message.channel) await message.channel.sendTyping().catch(() => {})
      const parsed = await interpret(input)
      if (!parsed) {
        await reply(USAGE)
        return true
      }
      stage = 'search'
      const result: ArchiveSearchResult = await search({
        guildId: message.guildId,
        channelId: message.channelId,
        userId: message.author.id,
        requestMessageId: message.id,
        ...parsed
      })
      let body = `**아카이브 검색**\n검색식: ${safeText(parsed.keyword, 200)} · 현재 채널의 전체 필드\n`
      if (!result.matches.length) body += '\n현재 원문에서 확인 가능한 검색 결과가 없습니다.\n'
      for (const item of result.matches.slice(0, 5)) {
        if (!/^\d{17,20}$/.test(item.id)) continue
        const line = `\n[원문](https://discord.com/channels/${message.guildId}/${message.channelId}/${item.id}) · ${safeText(item.authorName, 40)} · ${item.field === 'content' ? '본문' : item.field === 'embeds' ? '임베드' : '기타 필드'}\n> ${safeText(item.snippet, 180)}\n`
        if (body.length + line.length > 1830) break
        body += line
      }
      if (result.more) body += '\n-# 추가 결과는 검색어를 구체화해 확인하세요.'
      if (!result.historyComplete)
        body += '\n-# 과거 기록 수집이 완료되지 않아 일부 결과가 빠질 수 있습니다.'
      if (result.pendingEvents) body += '\n-# 실시간 반영을 기다리는 메시지가 있습니다.'
      await reply(body)
      clearRuntimeIssue('discord_archive_search')
    } catch (error) {
      if (error instanceof ArchiveQueryError) {
        await reply(`검색 문법 오류: ${error.message}\n${USAGE}`)
        return true
      }
      const detail = error instanceof Error ? error.message : ''
      const cause = error instanceof Error && error.cause ? error.cause : error
      const status =
        cause && typeof cause === 'object' && 'status' in cause ? cause.status : undefined
      const causeDetail = cause instanceof Error ? cause.message : ''
      const timeout = /timeout|timed out|abort/i.test(`${detail} ${causeDetail}`)
      const permission = status === 403 || /permission|History|members|administrator/i.test(detail)
      const schema = /Binder Error|Catalog Error|does not have a column|does not exist/i.test(
        detail
      )
      const category = timeout
        ? 'timeout'
        : permission
          ? 'permission'
          : schema
            ? 'schema'
            : 'unavailable'
      // Record only static categories and numeric HTTP status, never API bodies or request text.
      reportRuntimeIssue(
        'discord_archive_search',
        new Error(
          `stage=${stage}; category=${category}; status=${typeof status === 'number' ? status : 'unknown'}`
        )
      )
      const message = detail.includes('No archive exists')
        ? '이 채널의 아카이브가 없습니다. 관리자가 /a에서 채널 수집을 시작해야 합니다.'
        : detail.includes('index is preparing')
          ? '기존 메시지의 검색 색인을 준비하고 있습니다. 잠시 후 다시 검색해 주세요. 준비된 데이터는 유지됩니다.'
          : detail.includes('storage limit')
            ? '아카이브 저장 공간이 부족합니다. 관리자가 /a에서 저장 한도를 조정해 주세요.'
            : permission
              ? '채널 보기·메시지 기록 읽기 권한을 확인해 주세요.'
              : timeout
                ? '검색 처리 시간이 초과되었습니다. 잠시 후 다시 시도해 주세요.'
                : stage === 'interpret'
                  ? '검색식을 처리하지 못했습니다. 검색 문법을 확인해 주세요.'
                  : schema
                    ? '아카이브 형식이 현재 검색과 호환되지 않습니다. 관리자가 /a에서 이 채널의 수집을 다시 시작해 주세요.'
                    : detail.includes('busy')
                      ? '아카이브 수집이나 조회가 진행 중입니다. 잠시 후 다시 시도해 주세요.'
                      : '아카이브 조회 또는 원문 확인에 실패했습니다. 관리자가 /a에서 봇 상태를 확인해 주세요.'
      await reply(message)
    } finally {
      active = false
    }
    return true
  }
}
