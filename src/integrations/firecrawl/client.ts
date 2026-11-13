const FIRECRAWL_SCRAPE_URL = 'https://api.firecrawl.dev/v2/scrape'
const PREVIEW_LIMIT = 2800
const TIMEOUT_MS = 30000

export interface FirecrawlScrapePlan {
  originalTarget: string
  url: string
}

export interface FirecrawlScrapeResult {
  ok: boolean
  request: FirecrawlScrapePlan
  status?: number
  statusText?: string
  title?: string
  sourceUrl?: string
  contentPreview?: string
  error?: string
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function normalizeUrl(input: string): string {
  const parsed = new URL(input.includes('://') ? input : `https://${input}`)
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`bad url: ${input}`)
  }

  return parsed.toString()
}

function truncate(value: string): string {
  return value.length > PREVIEW_LIMIT ? `${value.slice(0, PREVIEW_LIMIT - 4)}\n...` : value
}

function stringValue(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key]
  return typeof value === 'string' && value.trim() ? value : undefined
}

function extractError(payload: unknown, fallback?: string): string | undefined {
  if (!isRecord(payload)) return fallback

  const error = stringValue(payload, 'error') ?? stringValue(payload, 'message')
  if (error) return error

  const details = payload.details
  if (Array.isArray(details)) {
    const first = details.find((detail) => typeof detail === 'string')
    if (first) return first
  }

  return fallback
}

function extractScrapedData(payload: unknown) {
  if (!isRecord(payload)) return {}
  const data = isRecord(payload.data) ? payload.data : payload
  const metadata = isRecord(data.metadata) ? data.metadata : {}

  const content =
    stringValue(data, 'markdown') ??
    stringValue(data, 'text') ??
    stringValue(data, 'html') ??
    stringValue(data, 'rawHtml')

  return {
    title: stringValue(metadata, 'title') ?? stringValue(data, 'title'),
    sourceUrl:
      stringValue(metadata, 'sourceURL') ??
      stringValue(metadata, 'url') ??
      stringValue(data, 'url'),
    contentPreview: content ? truncate(content) : undefined
  }
}

export function parseFirecrawlInvocation(args: string): FirecrawlScrapePlan | { error: string } {
  const restArgs = args.replace(/^\S+\s*/, '').trim()
  if (!restArgs) return { error: 'no url' }

  const tokens = restArgs.split(/\s+/)
  if (tokens.length > 1) return { error: `bad args: ${tokens.slice(1).join(' ')}` }

  try {
    return {
      originalTarget: tokens[0],
      url: normalizeUrl(tokens[0])
    }
  } catch (error) {
    return { error: error instanceof Error ? error.message : 'bad url' }
  }
}

export async function executeFirecrawlScrape(
  plan: FirecrawlScrapePlan,
  apiKey = process.env.FIRECRAWL_API_KEY?.trim()
): Promise<FirecrawlScrapeResult> {
  if (!apiKey) {
    return { ok: false, request: plan, error: 'no FIRECRAWL_API_KEY' }
  }

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)

  try {
    const response = await fetch(FIRECRAWL_SCRAPE_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ url: plan.url }),
      signal: controller.signal
    })

    const raw = await response.text()
    let payload: unknown = raw
    try {
      payload = raw ? JSON.parse(raw) : null
    } catch {
      payload = raw
    }

    const scraped = extractScrapedData(payload)
    return {
      ok: response.ok && !extractError(payload),
      request: plan,
      status: response.status,
      statusText: response.statusText || 'response',
      ...scraped,
      contentPreview: scraped.contentPreview ?? (raw ? truncate(raw) : undefined),
      error: response.ok ? extractError(payload) : extractError(payload, raw || response.statusText)
    }
  } catch (error) {
    return {
      ok: false,
      request: plan,
      error: error instanceof Error ? error.message : 'firecrawl req err'
    }
  } finally {
    clearTimeout(timer)
  }
}
