import { z } from 'zod'
import { archiveWebChannel, searchDiscordArchiveForWeb } from './discord-archive.js'
import { interpretArchiveSearch } from './archive-search-ai.js'
import { consumeStoredRateLimit } from './helpers/kv-store.js'
import { reportRuntimeIssue } from './runtime-health.js'

export const archiveWebSearchSchema = z
  .object({ prompt: z.string().trim().min(1).max(4000) })
  .strict()
export class ArchiveWebSearchError extends Error {
  constructor(
    public readonly status: number,
    message: string
  ) {
    super(message)
  }
}
export function archiveWebFailure(error: unknown): ArchiveWebSearchError {
  if (error instanceof ArchiveWebSearchError) return error
  const value = error && typeof error === 'object' ? error : {}
  const detail = error instanceof Error ? error.message : ''
  const status = 'status' in value ? value.status : undefined
  const code = 'code' in value ? value.code : undefined
  if (
    status === 403 ||
    status === 404 ||
    code === 10007 ||
    code === 50001 ||
    code === 50013 ||
    /permission|History|members|Unknown Member/i.test(detail)
  )
    return new ArchiveWebSearchError(
      403,
      '이 채널을 볼 수 없거나 메시지 기록을 읽을 권한이 없습니다.'
    )
  if (/not configured|No archive exists|disabled/.test(detail))
    return new ArchiveWebSearchError(
      503,
      '검색 채널이 준비되지 않았습니다. 관리자가 /a에서 수집 채널을 설정해야 합니다.'
    )
  if (/busy/.test(detail))
    return new ArchiveWebSearchError(
      429,
      '다른 검색 또는 수집이 진행 중입니다. 잠시 후 다시 시도해 주세요.'
    )
  reportRuntimeIssue(
    'archive_web_search',
    new Error(
      'Archive web search failed; check Discord access, archive availability and AI configuration'
    )
  )
  return new ArchiveWebSearchError(502, '검색을 완료하지 못했습니다. 잠시 후 다시 시도해 주세요.')
}

export function createArchiveWebSearch(
  channel = archiveWebChannel,
  interpret = interpretArchiveSearch,
  search = searchDiscordArchiveForWeb
) {
  const users = new Map<string, { until: number; count: number }>()
  let active = false
  return async (userId: string, raw: unknown) => {
    const { prompt } = archiveWebSearchSchema.parse(raw)
    if (!/^\d{17,20}$/.test(userId))
      throw new ArchiveWebSearchError(403, 'Discord 계정으로 로그인해 주세요.')
    const now = Date.now()
    for (const [id, value] of users) if (value.until <= now) users.delete(id)
    const user = users.get(userId) ?? { until: now + 60_000, count: 0 }
    if (
      (!users.has(userId) && users.size >= 1000) ||
      user.count >= 6 ||
      !consumeStoredRateLimit('web-rate:archive-search:minute', 30, 60_000) ||
      !consumeStoredRateLimit('web-rate:archive-search:hour', 300, 60 * 60_000)
    )
      throw new ArchiveWebSearchError(429, '검색 요청이 많습니다. 잠시 후 다시 시도해 주세요.')
    user.count++
    users.set(userId, user)
    if (active)
      throw new ArchiveWebSearchError(429, '다른 검색이 진행 중입니다. 잠시 후 다시 시도해 주세요.')
    active = true
    try {
      // Check real Discord permissions before spending tokens or returning channel metadata.
      await channel(userId)
      const intent = await interpret(prompt)
      if (!intent)
        throw new ArchiveWebSearchError(
          400,
          '찾을 내용을 조금 더 구체적으로 적어 주세요. 예: 본문에 털이 들어가는 글 찾아줘'
        )
      const result = await search(userId, intent)
      return { ...result, intent }
    } catch (error) {
      throw archiveWebFailure(error)
    } finally {
      active = false
    }
  }
}
export const runArchiveWebSearch = createArchiveWebSearch()
