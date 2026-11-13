import type { IncomingMessage, ServerResponse } from 'node:http'
import { authenticated, readJson, remoteId, sendJson } from '../http.js'
import { requireCsrf } from '../auth/session.js'
import { consumeStoredRateLimit } from '../../shared/storage/kv-store.js'
import { archiveWebChannel } from '../../features/archive/service.js'
import {
  archiveWebFailure,
  archiveWebSearchSchema,
  runArchiveWebSearch
} from '../../features/archive/search/web.js'
import { listPersonas, savePersona, deletePersona } from '../../features/conversation/personas.js'

export async function handleCommunityApi(
  request: IncomingMessage,
  response: ServerResponse,
  url: URL
): Promise<boolean> {
  const archive =
    url.pathname === '/api/archive-search/session' || url.pathname === '/api/archive-search'
  if (!archive && url.pathname !== '/api/personas') return false
  const session = authenticated(request, response, 'discord')
  if (!session) return true
  const method = request.method ?? 'GET'
  if (archive) {
    const sessionRoute = url.pathname.endsWith('/session')
    if (method !== (sessionRoute ? 'GET' : 'POST')) {
      response.setHeader('Allow', sessionRoute ? 'GET' : 'POST')
      sendJson(response, 405, { error: 'Method not allowed' })
      return true
    }
    if (!sessionRoute && !requireCsrf(request, session)) {
      sendJson(response, 403, {
        error: '로그인 상태가 변경되었습니다. 새로고침 후 다시 시도해 주세요.'
      })
      return true
    }
    try {
      if (sessionRoute) {
        if (!consumeStoredRateLimit('web-rate:archive-metadata', 120, 60_000)) {
          sendJson(response, 429, { error: '요청이 많습니다. 잠시 후 다시 시도해 주세요.' })
          return true
        }
        sendJson(response, 200, {
          user: { name: session.user.name },
          csrfToken: session.csrfToken,
          channel: await archiveWebChannel(session.user.discordId!)
        })
      } else {
        const body = archiveWebSearchSchema.parse(await readJson(request))
        sendJson(response, 200, await runArchiveWebSearch(session.user.discordId!, body))
      }
    } catch (error) {
      if (error instanceof SyntaxError || (error instanceof Error && error.name === 'ZodError')) {
        sendJson(response, 400, {
          error: '검색 요청은 1–4000자로 입력해 주세요. 채널이나 사용자 ID는 지정할 수 없습니다.'
        })
      } else {
        const failure = archiveWebFailure(error)
        sendJson(response, failure.status, { error: failure.message })
      }
    }
    return true
  }
  if (method === 'GET') {
    sendJson(response, 200, { personas: listPersonas(), csrfToken: session.csrfToken })
    return true
  }
  if (method !== 'PUT' && method !== 'DELETE') {
    response.setHeader('Allow', 'GET, PUT, DELETE')
    sendJson(response, 405, { error: 'Method not allowed' })
    return true
  }
  if (!requireCsrf(request, session)) {
    sendJson(response, 403, { error: 'Invalid CSRF token' })
    return true
  }
  const origin = request.headers.origin
  if (
    request.headers['x-persona-editor'] !== '1' ||
    request.headers['sec-fetch-site'] === 'cross-site' ||
    (origin && new URL(origin).host !== request.headers.host)
  ) {
    sendJson(response, 403, { error: 'Use the same-origin persona editor' })
    return true
  }
  if (
    !consumeStoredRateLimit('web-rate:persona-writes', 100, 60_000) ||
    !consumeStoredRateLimit(`web-rate:personas:${remoteId(request)}`, 20, 60_000)
  ) {
    sendJson(response, 429, { error: 'Too many persona edits; try again shortly' })
    return true
  }
  const body = await readJson(request)
  sendJson(response, 200, { personas: method === 'PUT' ? savePersona(body) : deletePersona(body) })
  return true
}
