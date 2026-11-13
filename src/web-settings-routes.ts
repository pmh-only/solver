import type { IncomingMessage, ServerResponse } from 'node:http'
import { authenticated, mutationAllowed, readJson, remoteId, sendJson } from './web-http.js'
import { consumeStoredRateLimit, hasStoredValue } from './helpers/kv-store.js'
import {
  getWebSession,
  loadOidcSettings,
  publicOidcSettings,
  saveOidcSettings
} from './web-auth.js'
import { loadSystemPromptSetting, updateSystemPrompt, resetSystemPrompt } from './system-prompt.js'
import {
  loadOpenAIEndpointSetting,
  loadOpenAITokenSetting,
  resetOpenAIEndpoint,
  resetOpenAIToken,
  updateOpenAIEndpoint,
  updateOpenAIToken
} from './openai-config.js'

interface SettingRoute {
  get: () => unknown
  update: (body: unknown, userId: string) => unknown
  reset: (userId: string) => unknown
}
const settings: Record<string, SettingRoute> = {
  '/api/admin/system-prompt': {
    get: loadSystemPromptSetting,
    update: updateSystemPrompt,
    reset: resetSystemPrompt
  },
  '/api/admin/openai-endpoint': {
    get: loadOpenAIEndpointSetting,
    update: updateOpenAIEndpoint,
    reset: resetOpenAIEndpoint
  },
  '/api/admin/openai-token': {
    get: loadOpenAITokenSetting,
    update: updateOpenAIToken,
    reset: resetOpenAIToken
  }
}

export async function handleSettingsApi(
  request: IncomingMessage,
  response: ServerResponse,
  url: URL
): Promise<boolean> {
  const method = request.method ?? 'GET'
  if (url.pathname === '/api/session' && method === 'GET') {
    const session = getWebSession(request)
    let oidc = null
    try {
      oidc = loadOidcSettings()
    } catch {
      /* Invalid configuration remains disabled. */
    }
    sendJson(response, 200, {
      user: session?.user ?? null,
      csrfToken: session?.csrfToken ?? null,
      oidcSetupRequired: !hasStoredValue('web-oidc-settings'),
      oidcEnabled: oidc?.enabled ?? false,
      automaticLogin: oidc?.automaticLogin ?? false
    })
    return true
  }
  if (url.pathname === '/api/admin/oidc' && method === 'GET') {
    if (hasStoredValue('web-oidc-settings') && !authenticated(request, response, 'admin'))
      return true
    sendJson(response, 200, publicOidcSettings())
    return true
  }
  if (url.pathname === '/api/admin/oidc' && method === 'PUT') {
    const initialSetup = !hasStoredValue('web-oidc-settings')
    if (initialSetup) {
      if (!consumeStoredRateLimit(`web-rate:oidc-setup:${remoteId(request)}`, 5, 15 * 60_000)) {
        sendJson(response, 429, { error: 'Too many setup attempts' })
        return true
      }
    } else if (!mutationAllowed(request, response, 'admin')) return true
    const body = await readJson(request)
    if (initialSetup && hasStoredValue('web-oidc-settings')) {
      sendJson(response, 409, { error: 'OIDC setup was completed by another request' })
      return true
    }
    if (initialSetup && (body as Record<string, unknown>).enabled !== true)
      throw new Error('Initial OIDC setup must enable login')
    sendJson(response, 200, saveOidcSettings(body))
    return true
  }
  const reset = url.pathname.endsWith('/reset')
  const setting = settings[reset ? url.pathname.slice(0, -'/reset'.length) : url.pathname]
  if (!setting || (reset ? method !== 'POST' : method !== 'GET' && method !== 'PUT')) return false
  const session =
    method === 'GET'
      ? authenticated(request, response, 'admin')
      : mutationAllowed(request, response, 'admin')
  if (!session) return true
  sendJson(
    response,
    200,
    method === 'GET'
      ? setting.get()
      : reset
        ? setting.reset(session.user.id)
        : setting.update(await readJson(request), session.user.id)
  )
  return true
}
