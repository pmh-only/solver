import type { Flags } from './flags.js'

const BODY_PREVIEW_LIMIT = 1000
const TIMEOUT_MS = 5000

export interface CurlRequestPlan {
  originalTarget: string
  url: string
  method: string
  headers: Record<string, string>
  body?: string
}

export interface CurlExecutionResult {
  ok: boolean
  request: CurlRequestPlan
  status?: number
  statusText?: string
  finalUrl?: string
  contentType?: string
  bodyPreview?: string
  error?: string
  output: string
}

function shellSplit(input: string): string[] {
  const tokens: string[] = []
  let current = ''
  let quote: 'single' | 'double' | null = null
  let escape = false

  for (const ch of input) {
    if (escape) {
      current += ch
      escape = false
      continue
    }

    if (ch === '\\' && quote !== 'single') {
      escape = true
      continue
    }

    if (quote === 'single') {
      if (ch === "'") quote = null
      else current += ch
      continue
    }

    if (quote === 'double') {
      if (ch === '"') quote = null
      else current += ch
      continue
    }

    if (ch === "'") {
      quote = 'single'
      continue
    }

    if (ch === '"') {
      quote = 'double'
      continue
    }

    if (/\s/.test(ch)) {
      if (current) {
        tokens.push(current)
        current = ''
      }
      continue
    }

    current += ch
  }

  if (quote) return []
  if (escape) current += '\\'
  if (current) tokens.push(current)
  return tokens
}

function normalizeUrl(input: string): string {
  try {
    return new URL(input.includes('://') ? input : `https://${input}`).toString()
  } catch {
    throw new Error(`bad url: ${input}`)
  }
}

function parseHeader(line: string): [string, string] | null {
  const index = line.indexOf(':')
  if (index === -1) return null
  const name = line.slice(0, index).trim()
  const value = line.slice(index + 1).trim()
  if (!name) return null
  return [name, value]
}

export function parseCurlInvocation(
  args: string,
  flags: Flags
): CurlRequestPlan | { error: string } {
  const restArgs = args.replace(/^\S+\s*/, '').trim()
  const tokens = shellSplit(restArgs)

  if (tokens.length === 0) {
    return { error: 'no url' }
  }

  const [target, ...remaining] = tokens
  const queue = [...remaining]
  let method = 'GET'
  let body: string | undefined
  const headers: Record<string, string> = {}

  for (const [key, value] of flags) {
    if (key === 'pub') continue

    const resolved = value === true ? queue.shift() : String(value)

    if (key === 'method') {
      if (!resolved) return { error: 'no method' }
      method = resolved.toUpperCase()
      continue
    }

    if (key === 'header') {
      if (!resolved) return { error: 'no header' }
      const parsed = parseHeader(resolved)
      if (!parsed) return { error: `bad hdr: ${resolved}` }
      headers[parsed[0]] = parsed[1]
      continue
    }

    if (key === 'data') {
      if (!resolved) return { error: 'no body' }
      body = resolved
      continue
    }

    return { error: `bad flag: --${key}` }
  }

  if (queue.length > 0) {
    return { error: `bad args: ${queue.join(' ')}` }
  }

  if (body && method === 'GET') method = 'POST'

  try {
    return {
      originalTarget: target,
      url: normalizeUrl(target),
      method,
      headers,
      body
    }
  } catch (error) {
    return { error: error instanceof Error ? error.message : 'bad url' }
  }
}

function isTextLike(contentType: string): boolean {
  return /^(text\/|application\/(json|xml|javascript|x-www-form-urlencoded))/i.test(contentType)
}

function formatBodyPreview(buffer: Buffer, contentType: string): string {
  if (!isTextLike(contentType)) {
    return `[bin: ${buffer.length}]`
  }

  const text = buffer.toString('utf8').replaceAll('\0', '')
  return text.length > BODY_PREVIEW_LIMIT ? `${text.slice(0, BODY_PREVIEW_LIMIT)}\n...` : text
}

export async function executeCurl(plan: CurlRequestPlan): Promise<CurlExecutionResult> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)

  try {
    const response = await fetch(plan.url, {
      method: plan.method,
      headers: plan.headers,
      body: plan.body,
      redirect: 'follow',
      signal: controller.signal
    })

    const body = Buffer.from(await response.arrayBuffer())
    const contentType = response.headers.get('content-type') ?? 'application/octet-stream'
    const bodyPreview = formatBodyPreview(body, contentType)
    const lines = [
      `**${plan.method} ${plan.originalTarget}**`,
      `-# ${response.status} ${response.statusText || 'response'}`,
      `-# url: ${response.url}`,
      `-# type: ${contentType}`,
      '```text',
      bodyPreview,
      '```'
    ]

    return {
      ok: response.ok,
      request: plan,
      status: response.status,
      statusText: response.statusText || 'response',
      finalUrl: response.url,
      contentType,
      bodyPreview,
      output: lines.join('\n')
    }
  } catch (error) {
    const detail = error instanceof Error ? error.message : 'req err'
    return {
      ok: false,
      request: plan,
      error: detail,
      output: `**${plan.method} ${plan.originalTarget}**\n-# err: ${detail}`
    }
  } finally {
    clearTimeout(timer)
  }
}
