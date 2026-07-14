import { afterEach, describe, expect, it, vi } from 'vitest'
import { InteractionResponseType, MessageFlags } from 'discord.js'
import { isUsageUserAllowed, subcommand as usage } from '../commands/usage.js'
import * as usageRuntime from '../commands/usage-runtime.js'
import type {
  OpenAIUsageReport,
  UsageDataset,
  UsageEndpointKey
} from '../commands/usage-runtime.js'
import { commandJSON, dispatch, getCallback, getEdit, makeSubcommands } from './e2e.js'

const USER_ID = '666666666666666666'
const subs = makeSubcommands(usage)

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { 'Content-Type': 'application/json' }
  })
}

function dataset(key: UsageEndpointKey, results: Record<string, unknown>[]): UsageDataset {
  return {
    key,
    path: `/organization/${key === 'costs' ? 'costs' : `usage/${key}`}`,
    group_by: ['project_id'],
    buckets: [{ start_time: 1_788_739_200, end_time: 1_788_825_600, results }]
  }
}

function sampleReport(): OpenAIUsageReport {
  return {
    generated_at: 1_788_782_400,
    start_time: 1_788_220_800,
    end_time: 1_788_782_400,
    days: 7,
    projects: [
      {
        id: 'proj_alpha',
        name: 'Alpha',
        status: 'active',
        created_at: 1_700_000_000,
        archived_at: null,
        external_key_id: 'alpha-ext'
      },
      {
        id: 'proj_idle',
        name: 'Idle',
        status: 'archived',
        created_at: 1_700_000_001,
        archived_at: 1_750_000_000,
        external_key_id: null
      }
    ],
    datasets: [
      dataset('completions', [
        {
          project_id: 'proj_alpha',
          model: 'gpt-5.4',
          api_key_id: 'key_alpha',
          user_id: 'user_alpha',
          service_tier: 'default',
          batch: false,
          num_model_requests: 3,
          input_tokens: 100,
          input_cached_tokens: 40,
          output_tokens: 25,
          input_audio_tokens: 2,
          output_audio_tokens: 1
        }
      ]),
      dataset('embeddings', [
        {
          project_id: 'proj_alpha',
          num_model_requests: 2,
          input_tokens: 50
        }
      ]),
      dataset('moderations', [
        {
          project_id: 'proj_alpha',
          num_model_requests: 1,
          input_tokens: 15
        }
      ]),
      dataset('images', [
        {
          project_id: 'proj_alpha',
          num_model_requests: 4,
          images: 6
        }
      ]),
      dataset('audio_speeches', [
        {
          project_id: 'proj_alpha',
          num_model_requests: 1,
          characters: 200
        }
      ]),
      dataset('audio_transcriptions', [
        {
          project_id: 'proj_alpha',
          num_model_requests: 2,
          seconds: 12.5
        }
      ]),
      dataset('code_interpreter_sessions', [
        {
          project_id: 'proj_alpha',
          num_sessions: 2
        }
      ]),
      dataset('file_search_calls', [
        {
          project_id: 'proj_alpha',
          num_requests: 8
        }
      ]),
      dataset('web_search_calls', [
        {
          project_id: 'proj_alpha',
          num_requests: 5,
          num_model_requests: 4
        }
      ]),
      dataset('vector_stores', [
        {
          project_id: 'proj_alpha',
          usage_bytes: 4096
        }
      ]),
      dataset('costs', [
        {
          project_id: 'proj_alpha',
          line_item: 'Responses API',
          amount: { currency: 'usd', value: 1.25 }
        }
      ])
    ]
  }
}

afterEach(() => {
  delete process.env.OPENAI_ADMIN_KEY
  delete process.env.OPENAI_USAGE_USER_IDS
  vi.restoreAllMocks()
})

describe('usage — command', () => {
  it('requires an explicit Discord user allowlist and never exposes publish controls', async () => {
    process.env.OPENAI_ADMIN_KEY = 'admin-key'
    process.env.OPENAI_USAGE_USER_IDS = '111111111111111111'
    const fetchSpy = vi.spyOn(usageRuntime, 'fetchOpenAIUsageReport')

    const calls = await dispatch(commandJSON('usage --pub'), subs)
    const body = getCallback(calls) as { type: number; data: { flags: number } }
    const serialized = JSON.stringify(body)

    expect(body.type).toBe(InteractionResponseType.ChannelMessageWithSource)
    expect(body.data.flags & MessageFlags.Ephemeral).toBeTruthy()
    expect(serialized).toContain('not configured for this Discord user')
    expect(serialized).not.toContain('Publish')
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('validates the requested day range before making an API request', async () => {
    process.env.OPENAI_ADMIN_KEY = 'admin-key'
    process.env.OPENAI_USAGE_USER_IDS = USER_ID
    const fetchSpy = vi.spyOn(usageRuntime, 'fetchOpenAIUsageReport')

    const calls = await dispatch(commandJSON('usage --days 32'), subs)
    const body = getCallback(calls) as { type: number; data: { flags: number } }

    expect(body.type).toBe(InteractionResponseType.ChannelMessageWithSource)
    expect(body.data.flags & MessageFlags.Ephemeral).toBeTruthy()
    expect(JSON.stringify(body)).toContain('days must be between 1 and 31')
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('returns every project, a detailed summary, and full report attachments privately', async () => {
    process.env.OPENAI_ADMIN_KEY = 'admin-key'
    process.env.OPENAI_USAGE_USER_IDS = `123, ${USER_ID}`
    const fetchSpy = vi
      .spyOn(usageRuntime, 'fetchOpenAIUsageReport')
      .mockResolvedValue(sampleReport())

    const calls = await dispatch(commandJSON('usage --days 7 --pub'), subs)
    const defer = getCallback(calls) as { type: number; data: { flags: number } }
    const edit = getEdit(calls)
    const patch = calls.find((call) => call.method === 'PATCH')
    const serialized = JSON.stringify(edit)

    expect(defer.type).toBe(InteractionResponseType.DeferredChannelMessageWithSource)
    expect(defer.data.flags & MessageFlags.Ephemeral).toBeTruthy()
    expect(fetchSpy).toHaveBeenCalledWith('admin-key', 7)
    expect(serialized).toContain('Alpha')
    expect(serialized).toContain('Idle')
    expect(serialized).toContain('$1.25')
    expect(serialized).toContain('Pin')
    expect(serialized).not.toContain('Publish')
    expect(serialized).toContain('attachment://openai-usage-')
    expect(patch?.files).toHaveLength(2)
  })
})

describe('usage — authorization', () => {
  it('accepts comma- and whitespace-separated user IDs', () => {
    expect(isUsageUserAllowed('222', '111,222 333')).toBe(true)
    expect(isUsageUserAllowed('444', '111,222 333')).toBe(false)
  })
})

describe('usage — Admin API runtime', () => {
  it('paginates projects and usage while requesting every supported detail dimension', async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input))
      expect(new Headers(init?.headers).get('Authorization')).toBe('Bearer admin-key')

      if (url.pathname === '/v1/organization/projects') {
        if (!url.searchParams.has('after')) {
          return jsonResponse({
            object: 'list',
            data: [
              {
                id: 'proj_alpha',
                name: 'Alpha',
                status: 'active',
                created_at: 1_700_000_000,
                archived_at: null,
                external_key_id: null
              }
            ],
            has_more: true,
            last_id: 'proj_alpha'
          })
        }
        expect(url.searchParams.get('after')).toBe('proj_alpha')
        return jsonResponse({
          object: 'list',
          data: [
            {
              id: 'proj_beta',
              name: 'Beta',
              status: 'archived',
              created_at: 1_700_000_001,
              archived_at: 1_750_000_000,
              external_key_id: 'beta-ext'
            }
          ],
          has_more: false,
          last_id: 'proj_beta'
        })
      }

      if (url.pathname === '/v1/organization/usage/completions') {
        if (!url.searchParams.has('page')) {
          return jsonResponse({
            object: 'page',
            data: [
              {
                object: 'bucket',
                start_time: 1_788_739_200,
                end_time: 1_788_782_400,
                results: [
                  {
                    project_id: 'proj_alpha',
                    model: 'gpt-5.4',
                    num_model_requests: 2,
                    input_tokens: 80,
                    input_cached_tokens: 30,
                    output_tokens: 20
                  }
                ]
              }
            ],
            has_more: true,
            next_page: 'usage-page-2'
          })
        }
        expect(url.searchParams.get('page')).toBe('usage-page-2')
        return jsonResponse({ object: 'page', data: [], has_more: false, next_page: null })
      }

      if (url.pathname === '/v1/organization/costs') {
        return jsonResponse({
          object: 'page',
          data: [
            {
              object: 'bucket',
              start_time: 1_788_739_200,
              end_time: 1_788_782_400,
              results: [
                {
                  project_id: 'proj_alpha',
                  line_item: 'Responses API',
                  amount: { currency: 'usd', value: 0.75 }
                }
              ]
            }
          ],
          has_more: false,
          next_page: null
        })
      }

      return jsonResponse({ object: 'page', data: [], has_more: false, next_page: null })
    })

    const report = await usageRuntime.fetchOpenAIUsageReport(
      'admin-key',
      2,
      fetchMock as typeof fetch,
      Date.UTC(2026, 8, 7, 12)
    )
    const urls = fetchMock.mock.calls.map(([input]) => new URL(String(input)))
    const firstCompletion = urls.find(
      (url) =>
        url.pathname === '/v1/organization/usage/completions' && !url.searchParams.has('page')
    )
    const costs = urls.find((url) => url.pathname === '/v1/organization/costs')

    expect(report.projects.map((project) => project.id)).toEqual(['proj_alpha', 'proj_beta'])
    expect(report.datasets).toHaveLength(usageRuntime.USAGE_ENDPOINTS.length)
    expect(new Set(report.datasets.map((entry) => entry.key))).toEqual(
      new Set(usageRuntime.USAGE_ENDPOINTS.map((entry) => entry.key))
    )
    expect(firstCompletion?.searchParams.getAll('group_by')).toEqual([
      'project_id',
      'user_id',
      'api_key_id',
      'model',
      'batch',
      'service_tier'
    ])
    expect(firstCompletion?.searchParams.get('limit')).toBe('2')
    expect(costs?.searchParams.getAll('group_by')).toEqual([
      'project_id',
      'line_item',
      'api_key_id'
    ])
    expect(urls.some((url) => url.searchParams.get('page') === 'usage-page-2')).toBe(true)
  })

  it('aggregates all usage categories and emits detailed dimensions', () => {
    const report = sampleReport()
    const summaries = usageRuntime.aggregateOpenAIUsage(report)
    const alpha = summaries.find((summary) => summary.id === 'proj_alpha')
    const idle = summaries.find((summary) => summary.id === 'proj_idle')
    const markdown = usageRuntime.formatOpenAIUsageMarkdown(report, summaries)

    expect(alpha).toMatchObject({
      costs: { usd: 1.25 },
      completionRequests: 3,
      inputTokens: 100,
      cachedInputTokens: 40,
      outputTokens: 25,
      embeddingRequests: 2,
      embeddingInputTokens: 50,
      moderationRequests: 1,
      imageRequests: 4,
      images: 6,
      speechRequests: 1,
      speechCharacters: 200,
      transcriptionRequests: 2,
      transcriptionSeconds: 12.5,
      codeInterpreterSessions: 2,
      fileSearchCalls: 8,
      webSearchCalls: 5,
      webSearchModelRequests: 4,
      peakVectorStoreBytes: 4096,
      models: ['gpt-5.4'],
      apiKeyIds: ['key_alpha'],
      userIds: ['user_alpha'],
      serviceTiers: ['default'],
      batchModes: ['false'],
      lineItems: ['Responses API']
    })
    expect(usageRuntime.projectHasUsage(alpha!)).toBe(true)
    expect(usageRuntime.projectHasUsage(idle!)).toBe(false)
    expect(markdown).toContain('## Alpha')
    expect(markdown).toContain('API key IDs: `key_alpha`')
    expect(markdown).toContain('Peak vector store usage: 4 KiB')
    expect(markdown).toContain('## Idle')
  })

  it('stops reading an oversized API page', async () => {
    const oversized = 'x'.repeat(8 * 1024 * 1024 + 1)
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = new URL(String(input))
      if (url.pathname === '/v1/organization/projects') return new Response(oversized)
      return jsonResponse({ object: 'page', data: [], has_more: false, next_page: null })
    })

    await expect(
      usageRuntime.fetchOpenAIUsageReport(
        'admin-key',
        1,
        fetchMock as typeof fetch,
        Date.UTC(2026, 8, 7, 12)
      )
    ).rejects.toThrow('response was too large')
  })
})
