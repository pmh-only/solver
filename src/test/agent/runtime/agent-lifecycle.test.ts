import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { runActiveAgentContext, runAgentContext } from '../../../agent/runtime/lifecycle.js'
import { activeDiscordRuns, activeWebRuns, sessionQueues } from '../../../agent/runtime/state.js'
import {
  deleteGptContext,
  loadGptContext,
  storeGptContext
} from '../../../agent/interactions/context.js'
import { agentSession, sharedAgentSession } from '../../../agent/sessions/identity.js'
import { runInSession, sessionKey } from '../../../agent/sessions/store.js'
import { runGptStream } from '../../../agent/streaming/runner.js'
import type { GptContext, StreamCallbacks } from '../../../agent/runtime/types.js'
import { clearStoredValues, getStoredValue } from '../../../shared/storage/kv-store.js'

vi.mock('../../../agent/streaming/runner.js', () => ({ runGptStream: vi.fn() }))

function context(): GptContext {
  return {
    prompt: 'test',
    displayPrompt: 'test',
    input: [],
    pub: true,
    model: 'test-model',
    effort: 'medium',
    maxTokens: 4096,
    toolsEnabled: false,
    verbosity: 'normal',
    userId: '666666666666666666',
    sessionName: 'work',
    history: [],
    modelHistory: [],
    components: [],
    senderOnlyComponentIds: [],
    modals: {},
    expiresAt: Date.now() + 60_000
  }
}
const callbacks: StreamCallbacks = { editMain: async () => {}, editPayload: async () => {} }

beforeEach(() => {
  clearStoredValues()
  vi.mocked(runGptStream).mockReset()
})
afterEach(() => {
  clearStoredValues()
  vi.restoreAllMocks()
})

describe('agent run lifecycle', () => {
  it.each(['web', 'discord'] as const)(
    'releases %s runs, context and queue on a stream failure',
    async (transport) => {
      const ctx = context()
      vi.mocked(runGptStream).mockRejectedValueOnce(new Error('delivery failed'))
      await expect(runActiveAgentContext(transport, ctx, 'failed', callbacks)).rejects.toThrow(
        'delivery failed'
      )
      expect(activeWebRuns.size).toBe(0)
      expect(activeDiscordRuns.size).toBe(0)
      expect(sessionQueues.size).toBe(0)
      expect(getStoredValue('gpt-ctx:failed')).toBeUndefined()
      expect(Number(getStoredValue('gpt-session-activity:work'))).toBeGreaterThan(0)
      await expect(runActiveAgentContext(transport, ctx, 'next', callbacks)).resolves.toBe(false)
    }
  )

  it('retains the latest interactive state when a continuation fails', async () => {
    const ctx = context()
    vi.mocked(runGptStream).mockImplementationOnce(async (_, current) => {
      current.components = [
        {
          type: 1,
          components: [
            { type: 2, style: 1, label: 'Retry', custom_id: 'gpt-action:retained:retry' }
          ]
        }
      ]
      throw new Error('delivery failed')
    })
    await expect(runAgentContext(ctx, 'retained', callbacks)).rejects.toThrow('delivery failed')
    expect(loadGptContext('retained')?.components).toEqual(ctx.components)
    expect(sessionQueues.size).toBe(0)
  })

  it('does not resurrect state invalidated while an interaction waited in the queue', async () => {
    const ctx = context()
    ctx.components = [{ type: 2, custom_id: 'gpt-action:stale:retry' }]
    storeGptContext('stale', ctx)
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const blocker = runInSession(agentSession(ctx.sessionName), () => gate)
    const pending = runAgentContext(ctx, 'stale', callbacks, {
      prepare: () => {
        const latest = loadGptContext('stale')
        if (!latest) throw new Error('Interaction expired')
        return latest
      }
    })
    const rejected = expect(pending).rejects.toThrow('Interaction expired')
    deleteGptContext('stale')
    release()
    await blocker
    await rejected
    expect(runGptStream).not.toHaveBeenCalled()
    expect(getStoredValue('gpt-ctx:stale')).toBeUndefined()
    expect(sessionQueues.size).toBe(0)
  })

  it('keeps existing persisted namespaces while exposing their scope explicitly', () => {
    const shared = sharedAgentSession('work')
    const privateSession = agentSession('__feature:private:opaque')
    const feature = agentSession('__feature:report:owner')
    expect([shared.scope, privateSession.scope, feature.scope]).toEqual([
      'shared',
      'private',
      'feature'
    ])
    expect(sessionKey(shared)).toBe('gpt-session:work')
    expect(sessionKey(privateSession)).toBe('gpt-session:__feature%3Aprivate%3Aopaque')
    expect(() => sharedAgentSession(privateSession.name)).toThrow('reserved')
    expect(() => sharedAgentSession(feature.name)).toThrow('reserved')
  })
})
