import { MessageFlags } from 'discord.js'
import { performance } from 'node:perf_hooks'
import type { RequestTiming } from '../request-timing.js'
import { deleteGptContext, storeGptContext } from './interaction-context.js'
import { buildAgentCancelledPayload, buildAgentProgressPayload } from './response-renderer.js'
import {
  activeDiscordRuns,
  activeWebRuns,
  cancelActiveSession,
  type ActiveWebRun
} from './runtime-state.js'
import type { GptContext, StreamCallbacks } from './runtime-types.js'
import { agentSession } from './session-identity.js'
import {
  beginSessionCommand,
  clearConversation,
  finishSessionCommand,
  loadContextConversation,
  runInSession,
  sessionKey
} from './session-store.js'
import { runGptStream } from './stream-runner.js'

interface ContextRunOptions {
  signal?: AbortSignal
  timing?: RequestTiming
  command?: boolean
  resetConversation?: boolean
  loadHistory?: boolean
  cancelBeforeLoad?: boolean
  /** Refresh and validate interactive state only after acquiring the session queue. */
  prepare?: () => GptContext
}

export async function runAgentContext(
  context: GptContext,
  token: string,
  callbacks: StreamCallbacks,
  options: ContextRunOptions = {}
): Promise<void> {
  const session = agentSession(context.sessionName)
  const queueStarted = performance.now()
  await runInSession(session, async () => {
    options.timing?.span('session queue wait', queueStarted)
    let ctx = context
    let prepared = false
    if (options.command) beginSessionCommand(session)
    try {
      ctx = options.prepare?.() ?? context
      if (ctx.sessionName !== session.name) throw new Error('Interaction session changed')
      prepared = true
      if (options.cancelBeforeLoad && options.signal?.aborted) {
        await callbacks.editPayload(
          buildAgentCancelledPayload(ctx, { reasoning: '', tools: [], responseStarted: false })
        )
        return
      }
      const loadStarted = performance.now()
      if (options.resetConversation) clearConversation(session)
      if (options.loadHistory !== false) loadContextConversation(ctx)
      options.timing?.span('conversation load', loadStarted)
      storeGptContext(token, ctx)
      await runGptStream(callbacks, ctx, token, options.signal, options.timing)
    } finally {
      try {
        if (prepared) {
          if (ctx.components.length === 0 && Object.keys(ctx.modals).length === 0)
            deleteGptContext(token)
          else storeGptContext(token, ctx)
        }
      } finally {
        if (options.command) finishSessionCommand(session)
      }
    }
  })
}

export async function runActiveAgentContext(
  transport: 'discord' | 'web',
  ctx: GptContext,
  token: string,
  callbacks: StreamCallbacks,
  options: {
    signal?: AbortSignal
    timing?: RequestTiming
    resetConversation?: boolean
    runId?: string
  } = {}
): Promise<boolean> {
  const key = sessionKey(agentSession(ctx.sessionName))
  cancelActiveSession(key)
  const controller = new AbortController()
  const abort = () => controller.abort()
  if (options.signal?.aborted) controller.abort()
  else options.signal?.addEventListener('abort', abort, { once: true })
  let finish!: () => void
  const done = new Promise<void>((resolve) => {
    finish = resolve
  })
  const active: ActiveWebRun = {
    id: options.runId ?? token,
    sessionName: ctx.sessionName,
    prompt: ctx.prompt,
    startedAt: new Date().toISOString(),
    controller,
    latestPayload: buildAgentProgressPayload(ctx),
    persisted: false,
    done,
    finish
  }
  const runs = transport === 'web' ? activeWebRuns : activeDiscordRuns
  runs.set(key, active)
  const tracked: StreamCallbacks = {
    editMain: async (components) => {
      active.latestPayload = {
        content: null,
        components: components as never,
        flags: MessageFlags.IsComponentsV2
      }
      return callbacks.editMain(components)
    },
    editPayload: async (payload) => {
      active.latestPayload = payload
      return callbacks.editPayload(payload)
    },
    stored: () => {
      active.persisted = true
      callbacks.stored?.()
    }
  }
  try {
    await runAgentContext(ctx, token, tracked, {
      ...options,
      signal: controller.signal,
      command: true,
      cancelBeforeLoad: transport === 'discord'
    })
  } finally {
    options.signal?.removeEventListener('abort', abort)
    if (runs.get(key) === active) runs.delete(key)
    finish()
  }
  return controller.signal.aborted
}
