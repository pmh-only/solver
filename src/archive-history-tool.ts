import { ZodError } from 'zod'
import {
  archiveHistoryContextSchema,
  archiveHistorySqlSchema,
  ArchiveHistorySqlError,
  type ArchiveHistoryContext
} from './archive-history-query.js'
import { searchDiscordHistory } from './discord-archive.js'
import { loadCommunitySettings } from './community-settings.js'
import { consumeStoredRateLimit } from './helpers/kv-store.js'
import { clearRuntimeIssue, reportRuntimeIssue } from './runtime-health.js'

export function createArchiveHistorySearch(context: ArchiveHistoryContext, roleChat = false) {
  const scope = archiveHistoryContextSchema.parse(context)
  let calls = 0
  return async (raw: unknown, signal: AbortSignal): Promise<string> => {
    try {
      if (++calls > 2)
        return JSON.stringify({ error: 'History search limit reached for this reply.' })
      signal.throwIfAborted()
      const settings = loadCommunitySettings()
      if (roleChat && !settings.roleChat?.archiveSearch)
        return JSON.stringify({ error: 'Role-chat history search is disabled through /a.' })
      const query = archiveHistorySqlSchema.parse(raw)
      if (
        !consumeStoredRateLimit('community:discord-archive:sql-rate:minute', 30, 60_000) ||
        !consumeStoredRateLimit('community:discord-archive:sql-rate:hour', 300, 60 * 60_000)
      )
        return JSON.stringify({ error: 'History search is rate limited. Try again later.' })
      const result = await searchDiscordHistory(scope, query, signal)
      clearRuntimeIssue('discord_archive_sql_search')
      return JSON.stringify(result)
    } catch (error) {
      if (error instanceof ArchiveHistorySqlError) return JSON.stringify({ error: error.message })
      if (error instanceof ZodError)
        return JSON.stringify({
          error:
            'Supply only {sql: "SELECT message_id FROM messages WHERE ..."}, at most 4000 characters.'
        })
      reportRuntimeIssue(
        'discord_archive_sql_search',
        new Error(
          'History SQL search failed; check channel access, archive availability and collection status through /a.'
        )
      )
      return JSON.stringify({
        error:
          'History search unavailable, busy or timed out. Check channel/history permissions and archive settings through /a. Do not invent results.'
      })
    }
  }
}
