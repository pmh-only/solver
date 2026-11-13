import { randomUUID } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import {
  runWebAgent,
  runWebComponentInteraction,
  runWebInteraction,
  loadWebConversation,
  clearWebConversation,
  cancelWebAgent,
  createWebSession,
  loadWebSessionState
} from './agent/index.js'
import { consumeStoredRateLimit } from './helpers/kv-store.js'
import { RequestTiming } from './request-timing.js'
import {
  loadSessionSystemPromptSetting,
  resetSessionSystemPrompt,
  updateSessionSystemPrompt
} from './system-prompt.js'
import {
  authenticated,
  mutationAllowed,
  readJson,
  safeError,
  sendJson,
  streamJson
} from './web-http.js'

const methods: Record<string, string[]> = {
  '/api/chat/system-prompt': ['GET', 'PUT'],
  '/api/chat/system-prompt/reset': ['POST'],
  '/api/chat/history': ['GET'],
  '/api/chat/sessions': ['GET', 'POST'],
  '/api/chat/clear': ['POST'],
  '/api/chat/cancel': ['POST'],
  '/api/chat/interaction': ['POST'],
  '/api/chat': ['POST'],
  '/api/interactions/components': ['POST']
}

export async function handleChatApi(
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
  requestStartedAt: number
): Promise<boolean> {
  const method = request.method ?? 'GET'
  if (!methods[url.pathname]?.includes(method)) return false
  const session =
    method === 'GET'
      ? authenticated(request, response, 'assistant')
      : mutationAllowed(request, response, 'assistant')
  if (!session) return true
  const userId = session.user.id
  if (method === 'GET') {
    const name = url.searchParams.get('session') || 'default'
    const value =
      url.pathname === '/api/chat/system-prompt'
        ? loadSessionSystemPromptSetting(userId, name)
        : url.pathname === '/api/chat/history'
          ? loadWebConversation(name)
          : url.searchParams.has('session')
            ? loadWebSessionState(name)
            : loadWebSessionState()
    sendJson(response, 200, value)
    return true
  }
  const rate =
    url.pathname === '/api/chat'
      ? (['chat', 20] as const)
      : url.pathname === '/api/chat/interaction'
        ? (['interaction', 40] as const)
        : url.pathname === '/api/interactions/components'
          ? (['component', 60] as const)
          : null
  if (rate && !consumeStoredRateLimit(`web-rate:${rate[0]}:${userId}`, rate[1], 60_000)) {
    sendJson(response, 429, { error: 'Rate limit exceeded' })
    return true
  }
  const body = (await readJson(request)) as Record<string, unknown>
  const name = typeof body.sessionName === 'string' ? body.sessionName : 'default'
  switch (url.pathname) {
    case '/api/chat/system-prompt':
      sendJson(response, 200, updateSessionSystemPrompt(userId, name, body, userId))
      break
    case '/api/chat/system-prompt/reset':
      sendJson(response, 200, resetSessionSystemPrompt(userId, name))
      break
    case '/api/chat/sessions':
      sendJson(
        response,
        201,
        createWebSession(typeof body.sessionName === 'string' ? body.sessionName : '')
      )
      break
    case '/api/chat/clear':
      await clearWebConversation(name)
      sendJson(response, 200, { ok: true })
      break
    case '/api/chat/cancel':
      sendJson(response, 200, {
        cancelled: await cancelWebAgent(
          name,
          typeof body.runId === 'string' ? body.runId : undefined
        )
      })
      break
    case '/api/chat': {
      const timing = body.debug === true ? new RequestTiming(requestStartedAt) : undefined
      timing?.mark('request body parsed and authorized')
      const runId = randomUUID()
      await streamJson(
        response,
        'continue',
        async (write) => {
          timing?.mark('response headers sent')
          await runWebAgent(
            {
              userId,
              prompt: typeof body.prompt === 'string' ? body.prompt : '',
              sessionName: typeof body.sessionName === 'string' ? body.sessionName : undefined,
              model: typeof body.model === 'string' ? body.model : undefined,
              effort: typeof body.effort === 'string' ? body.effort : undefined,
              maxTokens: typeof body.maxTokens === 'number' ? body.maxTokens : undefined,
              toolsEnabled: typeof body.toolsEnabled === 'boolean' ? body.toolsEnabled : undefined,
              runId,
              timing
            },
            async (payload) => write({ runId, payload })
          )
          if (timing) {
            timing.mark('server agent processing complete')
            write({ runId, timing: timing.snapshot() })
          }
          write({ runId, done: true })
        },
        (error, write) => {
          if (timing) write({ runId, timing: timing.snapshot() })
          write({ runId, error: safeError(error) })
        }
      )
      break
    }
    default:
      await streamJson(response, 'abort', async (write, signal) => {
        const customId = typeof body.customId === 'string' ? body.customId : ''
        const update = async (payload: unknown) => write({ payload })
        if (url.pathname === '/api/chat/interaction') {
          const result = await runWebInteraction(
            {
              userId,
              customId,
              values: body.values as string[] | undefined,
              fields: body.fields as never
            },
            update,
            signal
          )
          if ('modal' in result) write({ modal: result.modal })
        } else {
          const values = Array.isArray(body.values)
            ? body.values.filter((value): value is string => typeof value === 'string')
            : undefined
          await runWebComponentInteraction({ userId, customId, values }, update, signal)
        }
      })
  }
  return true
}
