const OPENAI_API_BASE = 'https://api.openai.com/v1'
const DAY_SECONDS = 86_400
const PAGE_LIMIT = 100
const MAX_PROJECT_PAGES = 100
const MAX_USAGE_PAGES = 10
const MAX_RESULTS_PER_DATASET = 50_000
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024
const MAX_REPORT_RESPONSE_BYTES = 40 * 1024 * 1024
const REQUEST_TIMEOUT_MS = 15_000

export const USAGE_ENDPOINTS = [
  {
    key: 'completions',
    path: '/organization/usage/completions',
    groupBy: ['project_id', 'user_id', 'api_key_id', 'model', 'batch', 'service_tier']
  },
  {
    key: 'embeddings',
    path: '/organization/usage/embeddings',
    groupBy: ['project_id', 'user_id', 'api_key_id', 'model']
  },
  {
    key: 'moderations',
    path: '/organization/usage/moderations',
    groupBy: ['project_id', 'user_id', 'api_key_id', 'model']
  },
  {
    key: 'images',
    path: '/organization/usage/images',
    groupBy: ['project_id', 'user_id', 'api_key_id', 'model', 'size', 'source']
  },
  {
    key: 'audio_speeches',
    path: '/organization/usage/audio_speeches',
    groupBy: ['project_id', 'user_id', 'api_key_id', 'model']
  },
  {
    key: 'audio_transcriptions',
    path: '/organization/usage/audio_transcriptions',
    groupBy: ['project_id', 'user_id', 'api_key_id', 'model']
  },
  {
    key: 'code_interpreter_sessions',
    path: '/organization/usage/code_interpreter_sessions',
    groupBy: ['project_id']
  },
  {
    key: 'file_search_calls',
    path: '/organization/usage/file_search_calls',
    groupBy: ['project_id', 'user_id', 'api_key_id', 'vector_store_id']
  },
  {
    key: 'web_search_calls',
    path: '/organization/usage/web_search_calls',
    groupBy: ['project_id', 'user_id', 'api_key_id', 'model', 'context_level']
  },
  {
    key: 'vector_stores',
    path: '/organization/usage/vector_stores',
    groupBy: ['project_id']
  },
  {
    key: 'costs',
    path: '/organization/costs',
    groupBy: ['project_id', 'line_item', 'api_key_id']
  }
] as const

export type UsageEndpointKey = (typeof USAGE_ENDPOINTS)[number]['key']

export interface OpenAIProject {
  id: string
  name: string | null
  status: string | null
  created_at: number
  archived_at: number | null
  external_key_id: string | null
}

export type UsageResult = Record<string, unknown>

export interface UsageBucket {
  start_time: number
  end_time: number
  results: UsageResult[]
}

export interface UsageDataset {
  key: UsageEndpointKey
  path: string
  group_by: string[]
  buckets: UsageBucket[]
}

export interface OpenAIUsageReport {
  generated_at: number
  start_time: number
  end_time: number
  days: number
  projects: OpenAIProject[]
  datasets: UsageDataset[]
}

export interface ProjectUsageSummary {
  id: string
  name: string
  status: string
  createdAt: number | null
  archivedAt: number | null
  externalKeyId: string | null
  costs: Record<string, number>
  completionRequests: number
  inputTokens: number
  cachedInputTokens: number
  outputTokens: number
  inputAudioTokens: number
  outputAudioTokens: number
  embeddingRequests: number
  embeddingInputTokens: number
  moderationRequests: number
  moderationInputTokens: number
  imageRequests: number
  images: number
  speechRequests: number
  speechCharacters: number
  transcriptionRequests: number
  transcriptionSeconds: number
  codeInterpreterSessions: number
  fileSearchCalls: number
  webSearchCalls: number
  webSearchModelRequests: number
  peakVectorStoreBytes: number
  models: string[]
  apiKeyIds: string[]
  userIds: string[]
  serviceTiers: string[]
  batchModes: string[]
  lineItems: string[]
}

interface MutableProjectUsageSummary extends Omit<
  ProjectUsageSummary,
  'models' | 'apiKeyIds' | 'userIds' | 'serviceTiers' | 'batchModes' | 'lineItems'
> {
  models: Set<string>
  apiKeyIds: Set<string>
  userIds: Set<string>
  serviceTiers: Set<string>
  batchModes: Set<string>
  lineItems: Set<string>
}

type FetchLike = typeof fetch

interface ResponseBudget {
  bytes: number
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function finiteNumber(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

function nullableString(value: unknown): string | null {
  return typeof value === 'string' ? value : null
}

function requiredNumber(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`OpenAI returned an invalid ${label}`)
  }
  return value
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value) {
    throw new Error(`OpenAI returned an invalid ${label}`)
  }
  return value
}

async function readResponseText(response: Response, path: string): Promise<string> {
  if (!response.body) return ''

  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0

  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.byteLength
    if (total > MAX_RESPONSE_BYTES) {
      await reader.cancel().catch(() => {})
      throw new Error(`OpenAI response was too large for ${path}`)
    }
    chunks.push(value)
  }

  const body = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    body.set(chunk, offset)
    offset += chunk.byteLength
  }
  return new TextDecoder().decode(body)
}

async function requestJson(
  url: URL,
  apiKey: string,
  fetcher: FetchLike,
  budget: ResponseBudget
): Promise<unknown> {
  const response = await fetcher(url, {
    headers: {
      Accept: 'application/json',
      Authorization: `Bearer ${apiKey}`
    },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
  })
  const body = await readResponseText(response, url.pathname)
  budget.bytes += Buffer.byteLength(body, 'utf8')
  if (budget.bytes > MAX_REPORT_RESPONSE_BYTES) {
    throw new Error('OpenAI usage data was too large; retry with fewer days')
  }

  let json: unknown
  try {
    json = body ? JSON.parse(body) : null
  } catch {
    throw new Error(`OpenAI returned invalid JSON for ${url.pathname}`)
  }

  if (!response.ok) {
    const detail =
      isRecord(json) && isRecord(json.error) && typeof json.error.message === 'string'
        ? `: ${json.error.message}`
        : ''
    throw new Error(`OpenAI ${url.pathname} failed (${response.status})${detail}`)
  }

  return json
}

async function fetchProjects(
  apiKey: string,
  fetcher: FetchLike,
  budget: ResponseBudget
): Promise<OpenAIProject[]> {
  const projects: OpenAIProject[] = []
  const seenCursors = new Set<string>()
  let after: string | undefined

  for (let pageNumber = 0; pageNumber < MAX_PROJECT_PAGES; pageNumber++) {
    const url = new URL(`${OPENAI_API_BASE}/organization/projects`)
    url.searchParams.set('limit', String(PAGE_LIMIT))
    url.searchParams.set('include_archived', 'true')
    if (after) url.searchParams.set('after', after)

    const json = await requestJson(url, apiKey, fetcher, budget)
    if (!isRecord(json) || !Array.isArray(json.data)) {
      throw new Error('OpenAI returned an invalid projects page')
    }

    for (const value of json.data) {
      if (!isRecord(value)) throw new Error('OpenAI returned an invalid project')
      projects.push({
        id: requiredString(value.id, 'project id'),
        name: nullableString(value.name),
        status: nullableString(value.status),
        created_at: requiredNumber(value.created_at, 'project creation time'),
        archived_at: finiteNumber(value.archived_at) || null,
        external_key_id: nullableString(value.external_key_id)
      })
    }

    if (json.has_more !== true) return projects

    const cursor =
      nullableString(json.last_id) ?? nullableString(json.next_page) ?? projects.at(-1)?.id ?? null
    if (!cursor || seenCursors.has(cursor)) {
      throw new Error('OpenAI projects pagination did not advance')
    }
    seenCursors.add(cursor)
    after = cursor
  }

  throw new Error('OpenAI projects exceeded the pagination limit')
}

function normalizeBuckets(value: unknown, path: string): UsageBucket[] {
  if (!Array.isArray(value)) throw new Error(`OpenAI returned invalid data for ${path}`)

  return value.map((bucket) => {
    if (!isRecord(bucket) || !Array.isArray(bucket.results)) {
      throw new Error(`OpenAI returned an invalid bucket for ${path}`)
    }
    const results = bucket.results.map((result) => {
      if (!isRecord(result)) throw new Error(`OpenAI returned an invalid result for ${path}`)
      return { ...result }
    })
    return {
      start_time: requiredNumber(bucket.start_time, 'bucket start time'),
      end_time: requiredNumber(bucket.end_time, 'bucket end time'),
      results
    }
  })
}

async function fetchDataset(
  endpoint: (typeof USAGE_ENDPOINTS)[number],
  apiKey: string,
  startTime: number,
  endTime: number,
  days: number,
  fetcher: FetchLike,
  budget: ResponseBudget
): Promise<UsageDataset> {
  const buckets: UsageBucket[] = []
  const seenCursors = new Set<string>()
  let resultCount = 0
  let page: string | undefined

  for (let pageNumber = 0; pageNumber < MAX_USAGE_PAGES; pageNumber++) {
    const url = new URL(`${OPENAI_API_BASE}${endpoint.path}`)
    url.searchParams.set('start_time', String(startTime))
    url.searchParams.set('end_time', String(endTime))
    url.searchParams.set('bucket_width', '1d')
    url.searchParams.set('limit', String(days))
    for (const dimension of endpoint.groupBy) url.searchParams.append('group_by', dimension)
    if (page) url.searchParams.set('page', page)

    const json = await requestJson(url, apiKey, fetcher, budget)
    if (!isRecord(json)) throw new Error(`OpenAI returned an invalid page for ${endpoint.path}`)
    const pageBuckets = normalizeBuckets(json.data, endpoint.path)
    resultCount += pageBuckets.reduce((total, bucket) => total + bucket.results.length, 0)
    if (resultCount > MAX_RESULTS_PER_DATASET) {
      throw new Error(`OpenAI ${endpoint.path} returned too many results; retry with fewer days`)
    }
    buckets.push(...pageBuckets)

    if (json.has_more !== true) {
      return {
        key: endpoint.key,
        path: endpoint.path,
        group_by: [...endpoint.groupBy],
        buckets
      }
    }

    const cursor = nullableString(json.next_page)
    if (!cursor || seenCursors.has(cursor)) {
      throw new Error(`OpenAI pagination did not advance for ${endpoint.path}`)
    }
    seenCursors.add(cursor)
    page = cursor
  }

  throw new Error(`OpenAI ${endpoint.path} exceeded the pagination limit`)
}

async function fetchDatasets(
  apiKey: string,
  startTime: number,
  endTime: number,
  days: number,
  fetcher: FetchLike,
  budget: ResponseBudget
): Promise<UsageDataset[]> {
  const datasets: UsageDataset[] = []

  for (let index = 0; index < USAGE_ENDPOINTS.length; index += 4) {
    datasets.push(
      ...(await Promise.all(
        USAGE_ENDPOINTS.slice(index, index + 4).map((endpoint) =>
          fetchDataset(endpoint, apiKey, startTime, endTime, days, fetcher, budget)
        )
      ))
    )
  }

  return datasets
}

export async function fetchOpenAIUsageReport(
  apiKey: string,
  days: number,
  fetcher: FetchLike = fetch,
  nowMs = Date.now()
): Promise<OpenAIUsageReport> {
  const endTime = Math.floor(nowMs / 1000)
  const startOfToday = Math.floor(endTime / DAY_SECONDS) * DAY_SECONDS
  const startTime = startOfToday - (days - 1) * DAY_SECONDS
  const budget: ResponseBudget = { bytes: 0 }
  const [projects, datasets] = await Promise.all([
    fetchProjects(apiKey, fetcher, budget),
    fetchDatasets(apiKey, startTime, endTime, days, fetcher, budget)
  ])

  return {
    generated_at: endTime,
    start_time: startTime,
    end_time: endTime,
    days,
    projects,
    datasets
  }
}

function emptySummary(project?: OpenAIProject): MutableProjectUsageSummary {
  return {
    id: project?.id ?? 'unattributed',
    name: project?.name ?? (project ? project.id : 'Unattributed'),
    status: project?.status ?? (project ? 'unknown' : 'unattributed'),
    createdAt: project?.created_at ?? null,
    archivedAt: project?.archived_at ?? null,
    externalKeyId: project?.external_key_id ?? null,
    costs: {},
    completionRequests: 0,
    inputTokens: 0,
    cachedInputTokens: 0,
    outputTokens: 0,
    inputAudioTokens: 0,
    outputAudioTokens: 0,
    embeddingRequests: 0,
    embeddingInputTokens: 0,
    moderationRequests: 0,
    moderationInputTokens: 0,
    imageRequests: 0,
    images: 0,
    speechRequests: 0,
    speechCharacters: 0,
    transcriptionRequests: 0,
    transcriptionSeconds: 0,
    codeInterpreterSessions: 0,
    fileSearchCalls: 0,
    webSearchCalls: 0,
    webSearchModelRequests: 0,
    peakVectorStoreBytes: 0,
    models: new Set(),
    apiKeyIds: new Set(),
    userIds: new Set(),
    serviceTiers: new Set(),
    batchModes: new Set(),
    lineItems: new Set()
  }
}

function addString(target: Set<string>, value: unknown) {
  if (typeof value === 'string' && value) target.add(value)
}

export function aggregateOpenAIUsage(report: OpenAIUsageReport): ProjectUsageSummary[] {
  const summaries = new Map<string, MutableProjectUsageSummary>()
  for (const project of report.projects) summaries.set(project.id, emptySummary(project))

  const getSummary = (projectId: unknown) => {
    const id = typeof projectId === 'string' && projectId ? projectId : 'unattributed'
    let summary = summaries.get(id)
    if (!summary) {
      summary = emptySummary(
        id === 'unattributed'
          ? undefined
          : {
              id,
              name: id,
              status: 'unknown',
              created_at: 0,
              archived_at: null,
              external_key_id: null
            }
      )
      summaries.set(id, summary)
    }
    return summary
  }

  for (const dataset of report.datasets) {
    for (const bucket of dataset.buckets) {
      for (const result of bucket.results) {
        const summary = getSummary(result.project_id)
        addString(summary.models, result.model)
        addString(summary.apiKeyIds, result.api_key_id)
        addString(summary.userIds, result.user_id)
        addString(summary.serviceTiers, result.service_tier)
        if (typeof result.batch === 'boolean') summary.batchModes.add(String(result.batch))
        addString(summary.lineItems, result.line_item)

        switch (dataset.key) {
          case 'completions':
            summary.completionRequests += finiteNumber(result.num_model_requests)
            summary.inputTokens += finiteNumber(result.input_tokens)
            summary.cachedInputTokens += finiteNumber(result.input_cached_tokens)
            summary.outputTokens += finiteNumber(result.output_tokens)
            summary.inputAudioTokens += finiteNumber(result.input_audio_tokens)
            summary.outputAudioTokens += finiteNumber(result.output_audio_tokens)
            break
          case 'embeddings':
            summary.embeddingRequests += finiteNumber(result.num_model_requests)
            summary.embeddingInputTokens += finiteNumber(result.input_tokens)
            break
          case 'moderations':
            summary.moderationRequests += finiteNumber(result.num_model_requests)
            summary.moderationInputTokens += finiteNumber(result.input_tokens)
            break
          case 'images':
            summary.imageRequests += finiteNumber(result.num_model_requests)
            summary.images += finiteNumber(result.images)
            break
          case 'audio_speeches':
            summary.speechRequests += finiteNumber(result.num_model_requests)
            summary.speechCharacters += finiteNumber(result.characters)
            break
          case 'audio_transcriptions':
            summary.transcriptionRequests += finiteNumber(result.num_model_requests)
            summary.transcriptionSeconds += finiteNumber(result.seconds)
            break
          case 'code_interpreter_sessions':
            summary.codeInterpreterSessions += finiteNumber(result.num_sessions)
            break
          case 'file_search_calls':
            summary.fileSearchCalls += finiteNumber(result.num_requests)
            break
          case 'web_search_calls':
            summary.webSearchCalls += finiteNumber(result.num_requests)
            summary.webSearchModelRequests += finiteNumber(result.num_model_requests)
            break
          case 'vector_stores':
            summary.peakVectorStoreBytes = Math.max(
              summary.peakVectorStoreBytes,
              finiteNumber(result.usage_bytes)
            )
            break
          case 'costs': {
            const amount = isRecord(result.amount) ? result.amount : null
            const currency = amount ? nullableString(amount.currency) : null
            if (currency) {
              summary.costs[currency] = (summary.costs[currency] ?? 0) + finiteNumber(amount?.value)
            }
            break
          }
        }
      }
    }
  }

  return [...summaries.values()]
    .map((summary) => ({
      ...summary,
      models: [...summary.models].sort(),
      apiKeyIds: [...summary.apiKeyIds].sort(),
      userIds: [...summary.userIds].sort(),
      serviceTiers: [...summary.serviceTiers].sort(),
      batchModes: [...summary.batchModes].sort(),
      lineItems: [...summary.lineItems].sort()
    }))
    .sort((left, right) => left.name.localeCompare(right.name))
}

function formatInteger(value: number): string {
  return Math.round(value).toLocaleString('en-US')
}

function formatDecimal(value: number): string {
  return value.toLocaleString('en-US', { maximumFractionDigits: 3 })
}

function formatBytes(value: number): string {
  if (value < 1024) return `${formatInteger(value)} B`
  const units = ['KiB', 'MiB', 'GiB', 'TiB']
  let amount = value
  let unit = -1
  do {
    amount /= 1024
    unit++
  } while (amount >= 1024 && unit < units.length - 1)
  return `${amount.toLocaleString('en-US', { maximumFractionDigits: 2 })} ${units[unit]}`
}

export function formatCosts(costs: Record<string, number>): string {
  const entries = Object.entries(costs).sort(([left], [right]) => left.localeCompare(right))
  if (entries.length === 0) return '0'
  return entries
    .map(([currency, value]) => {
      const amount = value.toLocaleString('en-US', {
        minimumFractionDigits: 2,
        maximumFractionDigits: 6
      })
      return currency.toLowerCase() === 'usd' ? `$${amount}` : `${amount} ${currency.toUpperCase()}`
    })
    .join(', ')
}

function formatTimestamp(value: number | null): string {
  return value ? new Date(value * 1000).toISOString() : 'n/a'
}

function list(values: string[]): string {
  return values.length > 0
    ? values.map((value) => `\`${value.replaceAll('`', '\\`')}\``).join(', ')
    : 'none'
}

function markdownName(value: string): string {
  return value.replace(/([\\`*_[\]])/g, '\\$1')
}

export function formatOpenAIUsageMarkdown(
  report: OpenAIUsageReport,
  summaries = aggregateOpenAIUsage(report)
): string {
  const lines = [
    '# OpenAI organization usage',
    '',
    `- Generated: ${formatTimestamp(report.generated_at)}`,
    `- Period: ${formatTimestamp(report.start_time)} to ${formatTimestamp(report.end_time)} (end exclusive)`,
    `- Requested window: ${report.days} UTC day${report.days === 1 ? '' : 's'}`,
    `- Projects: ${summaries.length}`,
    `- Raw datasets: ${report.datasets.map((dataset) => dataset.key).join(', ')}`,
    ''
  ]

  for (const summary of summaries) {
    lines.push(
      `## ${markdownName(summary.name)}`,
      '',
      `- Project ID: \`${summary.id}\``,
      `- Status: ${summary.status}`,
      `- Created: ${formatTimestamp(summary.createdAt)}`,
      `- Archived: ${formatTimestamp(summary.archivedAt)}`,
      `- External key ID: ${summary.externalKeyId ? `\`${summary.externalKeyId}\`` : 'none'}`,
      `- Cost: ${formatCosts(summary.costs)}`,
      '',
      '### Generation',
      '',
      `- Requests: ${formatInteger(summary.completionRequests)}`,
      `- Input tokens: ${formatInteger(summary.inputTokens)}`,
      `- Cached input tokens: ${formatInteger(summary.cachedInputTokens)}`,
      `- Output tokens: ${formatInteger(summary.outputTokens)}`,
      `- Input audio tokens: ${formatInteger(summary.inputAudioTokens)}`,
      `- Output audio tokens: ${formatInteger(summary.outputAudioTokens)}`,
      '',
      '### Other APIs and tools',
      '',
      `- Embeddings: ${formatInteger(summary.embeddingRequests)} requests, ${formatInteger(summary.embeddingInputTokens)} input tokens`,
      `- Moderations: ${formatInteger(summary.moderationRequests)} requests, ${formatInteger(summary.moderationInputTokens)} input tokens`,
      `- Images: ${formatInteger(summary.imageRequests)} requests, ${formatInteger(summary.images)} images`,
      `- Speech: ${formatInteger(summary.speechRequests)} requests, ${formatInteger(summary.speechCharacters)} characters`,
      `- Transcriptions: ${formatInteger(summary.transcriptionRequests)} requests, ${formatDecimal(summary.transcriptionSeconds)} seconds`,
      `- Code Interpreter: ${formatInteger(summary.codeInterpreterSessions)} sessions`,
      `- File search: ${formatInteger(summary.fileSearchCalls)} calls`,
      `- Web search: ${formatInteger(summary.webSearchCalls)} calls, ${formatInteger(summary.webSearchModelRequests)} model requests`,
      `- Peak vector store usage: ${formatBytes(summary.peakVectorStoreBytes)}`,
      '',
      '### Dimensions',
      '',
      `- Models: ${list(summary.models)}`,
      `- API key IDs: ${list(summary.apiKeyIds)}`,
      `- OpenAI user IDs: ${list(summary.userIds)}`,
      `- Service tiers: ${list(summary.serviceTiers)}`,
      `- Batch modes: ${list(summary.batchModes)}`,
      `- Cost line items: ${list(summary.lineItems)}`,
      ''
    )
  }

  return lines.join('\n')
}

export function projectHasUsage(summary: ProjectUsageSummary): boolean {
  return (
    Object.values(summary.costs).some((value) => value !== 0) ||
    summary.completionRequests > 0 ||
    summary.inputTokens > 0 ||
    summary.outputTokens > 0 ||
    summary.embeddingRequests > 0 ||
    summary.moderationRequests > 0 ||
    summary.imageRequests > 0 ||
    summary.speechRequests > 0 ||
    summary.transcriptionRequests > 0 ||
    summary.codeInterpreterSessions > 0 ||
    summary.fileSearchCalls > 0 ||
    summary.webSearchCalls > 0 ||
    summary.peakVectorStoreBytes > 0
  )
}
