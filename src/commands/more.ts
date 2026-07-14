import { lookup } from 'node:dns/promises'
import tls from 'node:tls'
import { createHash, randomUUID } from 'node:crypto'
import type { Flags } from '../flags.js'
import type { CommandInteraction, Subcommand, CommandRunResult } from '../types.js'
import {
  codeBlock,
  commandContainer,
  commandReferenceReply,
  keyValueBlock,
  runRerunnableCommand,
  sendCommandReply,
  separator,
  summarySection
} from '../components.js'
import { poll } from './more-poll.js'
import { getStoredValue, listStoredKeys, setStoredValue } from '../helpers/kv-store.js'

const PREVIEW_LIMIT = 120_000
const FETCH_TIMEOUT_MS = 10_000
const SHORT_PREFIX = 'short:'
const QUOTE_PREFIX = 'quote:'
const reminders = new Map<string, ReturnType<typeof setTimeout>>()

interface FetchSummary {
  url: string
  finalUrl: string
  status: number
  statusText: string
  contentType: string
  bytes: number
  hash: string
  bodyPreview: string
  headers: [string, string][]
}

function restArgs(args: string): string {
  return args.replace(/^\S+\s*/, '').trim()
}

function ensureUrl(input: string): string {
  return new URL(input.includes('://') ? input : `https://${input}`).toString()
}

function truncate(value: string, max = 1800): string {
  return value.length > max ? `${value.slice(0, max - 3)}...` : value
}

function firstToken(value: string): { token: string; rest: string } {
  const trimmed = value.trim()
  const [token = '', ...rest] = trimmed.split(/\s+/)
  return { token, rest: rest.join(' ') }
}

async function fetchWithTimeout(url: string, init: RequestInit = {}): Promise<Response> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)
  timer.unref?.()
  try {
    return await fetch(url, { ...init, signal: controller.signal })
  } finally {
    clearTimeout(timer)
  }
}

async function readSummary(target: string, method = 'GET'): Promise<FetchSummary> {
  const url = ensureUrl(target)
  const response = await fetchWithTimeout(url, { method, redirect: 'follow' })
  const buffer = Buffer.from(await response.arrayBuffer())
  const sample = buffer.subarray(0, PREVIEW_LIMIT)

  return {
    url,
    finalUrl: response.url,
    status: response.status,
    statusText: response.statusText,
    contentType: response.headers.get('content-type') ?? 'unknown',
    bytes: buffer.byteLength,
    hash: createHash('sha256').update(buffer).digest('hex'),
    bodyPreview: sample.toString('utf8'),
    headers: [...response.headers.entries()]
  }
}

function splitArgs(value: string): string[] {
  return value.split(/\s+/).filter(Boolean)
}

function parsePipeArgs(value: string): string[] {
  return value
    .split('|')
    .map((part) => part.trim())
    .filter(Boolean)
}

function formatDuration(ms: number): string {
  const sec = Math.round(ms / 1000)
  if (sec < 60) return `${sec}s`
  const min = Math.floor(sec / 60)
  const rem = sec % 60
  if (min < 60) return rem ? `${min}m ${rem}s` : `${min}m`
  const hours = Math.floor(min / 60)
  const minRem = min % 60
  return minRem ? `${hours}h ${minRem}m` : `${hours}h`
}

function parseDuration(input: string): number | null {
  const match = input.match(/^(\d+)(s|m|h|d)$/i)
  if (!match) return null
  const amount = Number.parseInt(match[1] ?? '', 10)
  const unit = (match[2] ?? '').toLowerCase()
  const scale = unit === 's' ? 1000 : unit === 'm' ? 60_000 : unit === 'h' ? 3_600_000 : 86_400_000
  const ms = amount * scale
  return Number.isFinite(ms) && ms > 0 ? Math.min(ms, 7 * 86_400_000) : null
}

function parseJwtPart(part: string): string {
  const padded = part.padEnd(Math.ceil(part.length / 4) * 4, '=')
  return Buffer.from(padded.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8')
}

function stableSlug(input: string): string {
  return createHash('sha1').update(input).digest('hex').slice(0, 8)
}

async function runJson(args: string): Promise<CommandRunResult> {
  const input = restArgs(args)
  if (!input) throw new Error('no json')
  const parsed = JSON.parse(input) as unknown
  return [summarySection('JSON', ['valid JSON']), separator(), codeBlock('Pretty', JSON.stringify(parsed, null, 2), 'json')]
}

async function runJwt(args: string): Promise<CommandRunResult> {
  const token = restArgs(args)
  const parts = token.split('.')
  if (parts.length < 2) throw new Error('bad jwt')
  const header = JSON.stringify(JSON.parse(parseJwtPart(parts[0] ?? '')) as unknown, null, 2)
  const payload = JSON.stringify(JSON.parse(parseJwtPart(parts[1] ?? '')) as unknown, null, 2)
  return [summarySection('JWT', ['decoded without verification']), separator(), codeBlock('Header', header, 'json'), codeBlock('Payload', payload, 'json')]
}

async function runHash(args: string, flags: Flags): Promise<CommandRunResult> {
  const input = restArgs(args)
  if (!input) throw new Error('no text')
  const alg = typeof flags.get('alg') === 'string' ? String(flags.get('alg')) : 'sha256'
  if (!['sha256', 'sha512', 'md5'].includes(alg)) throw new Error('bad alg')
  const digest = createHash(alg).update(input).digest('hex')
  return [summarySection('Hash', [`-# alg: ${alg}`, `-# bytes: ${Buffer.byteLength(input)}`]), separator(), codeBlock('Digest', digest)]
}

function runTime(args: string): CommandRunResult {
  const input = restArgs(args)
  const date = input ? new Date(input) : new Date()
  if (Number.isNaN(date.getTime())) throw new Error('bad time')
  return keyValueBlock('Time', [
    ['local', date.toString()],
    ['utc', date.toISOString()],
    ['unix', Math.floor(date.getTime() / 1000)]
  ])
}

function runRegex(args: string): CommandRunResult {
  const parts = parsePipeArgs(restArgs(args))
  if (parts.length < 2) throw new Error('usage: regex <pattern> | <text>')
  const regex = new RegExp(parts[0] ?? '', 'g')
  const matches = [...(parts[1] ?? '').matchAll(regex)].slice(0, 25)
  return [
    summarySection('Regex', [`${matches.length} match${matches.length === 1 ? '' : 'es'}`]),
    separator(),
    codeBlock('Matches', matches.map((match, index) => `${index + 1}. ${match[0]}`).join('\n') || 'none')
  ]
}

async function followUpLater(interaction: CommandInteraction, content: string) {
  if ('followUp' in interaction) {
    await interaction.followUp({ content })
  }
}

function scheduleLater(interaction: CommandInteraction, ms: number, message: string): string {
  const id = randomUUID().replace(/-/g, '').slice(0, 8)
  const timer = setTimeout(() => {
    reminders.delete(id)
    void followUpLater(interaction, message).catch(() => undefined)
  }, ms)
  timer.unref?.()
  reminders.set(id, timer)
  return id
}

async function openAiOcr(imageUrl: string): Promise<string> {
  const key = process.env.OPENAI_API_KEY
  if (!key) throw new Error('OPENAI_API_KEY missing')
  const response = await fetch('https://api.openai.com/v1/responses', {
    method: 'POST',
    headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      model: 'gpt-5.4-mini',
      input: [
        {
          role: 'user',
          content: [
            { type: 'input_text', text: 'Extract all visible text from this image. Return only the text.' },
            { type: 'input_image', image_url: imageUrl }
          ]
        }
      ]
    })
  })
  const payload = (await response.json()) as { output_text?: unknown; error?: { message?: unknown } }
  if (!response.ok) throw new Error(typeof payload.error?.message === 'string' ? payload.error.message : 'ocr failed')
  if (typeof payload.output_text !== 'string') throw new Error('ocr returned no text')
  return payload.output_text
}

async function traceRedirects(target: string): Promise<string[]> {
  const lines: string[] = []
  let current = ensureUrl(target)
  for (let i = 0; i < 6; i++) {
    const response = await fetchWithTimeout(current, { method: 'HEAD', redirect: 'manual' })
    lines.push(`${i + 1}. ${response.status} ${response.statusText} ${current}`)
    const next = response.headers.get('location')
    if (!next || response.status < 300 || response.status >= 400) break
    current = new URL(next, current).toString()
  }
  return lines
}

async function tlsSummary(target: string): Promise<string[]> {
  const url = new URL(ensureUrl(target))
  const host = url.hostname
  const port = url.port ? Number.parseInt(url.port, 10) : 443
  return await new Promise((resolve) => {
    const socket = tls.connect({ host, port, servername: host, timeout: FETCH_TIMEOUT_MS }, () => {
      const cert = socket.getPeerCertificate()
      socket.end()
      resolve([`-# tls subject: ${cert.subject?.CN ?? host}`, `-# tls valid to: ${cert.valid_to ?? 'unknown'}`])
    })
    socket.once('timeout', () => {
      socket.destroy()
      resolve(['-# tls: timeout'])
    })
    socket.once('error', (error) => resolve([`-# tls: ${error.message}`]))
  })
}

async function runTrace(args: string): Promise<CommandRunResult> {
  const target = restArgs(args)
  if (!target) throw new Error('no host')
  const url = new URL(ensureUrl(target))
  const addresses = await lookup(url.hostname, { all: true }).catch((error: Error) => [{ address: error.message, family: 0 }])
  const redirects = await traceRedirects(target).catch((error: Error) => [`http: ${error.message}`])
  const tlsLines = url.protocol === 'https:' ? await tlsSummary(target) : []
  return [
    summarySection(`Trace ${url.hostname}`, [
      `-# dns: ${addresses.map((entry) => `${entry.address}/${entry.family}`).join(', ')}`,
      ...tlsLines
    ]),
    separator(),
    codeBlock('HTTP redirects', redirects.join('\n'))
  ]
}

function simpleRerunnable(name: string, description: string, usage: string, examples: string[], run: (args: string, flags: Flags) => Promise<CommandRunResult> | CommandRunResult, flagsDef?: Subcommand['flags']): Subcommand {
  const subcommand: Subcommand = {
    name,
    description,
    usage,
    examples,
    flags: flagsDef,
    async run(args, flags) {
      return await run(args, flags)
    },
    async execute(interaction, args, flags) {
      try {
        if (!restArgs(args) && !['time'].includes(name)) throw new Error(usage)
        await runRerunnableCommand(interaction, subcommand, args, flags, async () => subcommand.run!(args, flags))
      } catch (error) {
        await sendCommandReply(interaction, commandReferenceReply(subcommand, args, flags, 'usage', error instanceof Error ? error.message : 'err'))
      }
    }
  }
  return subcommand
}

export const headers = simpleRerunnable('headers', 'show http headers', 'headers <url> [--pub]', ['headers example.com'], async (args) => {
  const result = await readSummary(restArgs(args), 'HEAD')
  return [
    summarySection(`Headers ${result.url}`, [`-# status: ${result.status} ${result.statusText}`, `-# final: ${result.finalUrl}`], { label: 'Open URL', url: result.finalUrl }),
    separator(),
    codeBlock('Headers', result.headers.map(([key, value]) => `${key}: ${value}`).join('\n'))
  ]
})

export const httpdiff = simpleRerunnable('httpdiff', 'compare two urls', 'httpdiff <url-a> <url-b> [--pub]', ['httpdiff example.com example.org'], async (args) => {
  const [left, right] = splitArgs(restArgs(args))
  if (!left || !right) throw new Error('need two urls')
  const [a, b] = await Promise.all([readSummary(left), readSummary(right)])
  return [
    summarySection('HTTP diff', [`-# ${a.url}`, `-# ${b.url}`]),
    separator(),
    keyValueBlock('Comparison', [
      ['status', `${a.status} vs ${b.status}`],
      ['type', `${a.contentType} vs ${b.contentType}`],
      ['bytes', `${a.bytes} vs ${b.bytes}`],
      ['sha256', `${a.hash.slice(0, 16)} vs ${b.hash.slice(0, 16)}`],
      ['same body', a.hash === b.hash]
    ])
  ]
})

export const trace = simpleRerunnable('trace', 'dns http tls trace', 'trace <host> [--pub]', ['trace example.com'], runTrace)

export const qr: Subcommand = {
  name: 'qr',
  description: 'make qr link',
  usage: 'qr <text> [--pub]',
  examples: ['qr https://example.com', 'qr hello world'],
  async execute(interaction, args, flags) {
    const value = restArgs(args)
    if (!value) {
      await sendCommandReply(interaction, commandReferenceReply(qr, args, flags, 'usage', 'no text'))
      return
    }
    const url = `https://api.qrserver.com/v1/create-qr-code/?size=512x512&data=${encodeURIComponent(value)}`
    await sendCommandReply(interaction, commandContainer(qr, args, flags, summarySection('QR code', [`-# ${truncate(value, 120)}`], { label: 'Open QR', url })))
  }
}

export const short: Subcommand = {
  name: 'short',
  description: 'local url shortcut',
  usage: 'short <url> [slug] | short <slug> [--pub]',
  examples: ['short https://example.com', 'short example'],
  async execute(interaction, args, flags) {
    const parts = splitArgs(restArgs(args))
    if (parts.length === 0) {
      await sendCommandReply(interaction, commandReferenceReply(short, args, flags, 'usage', 'no args'))
      return
    }
    const first = parts[0] ?? ''
    if (/^https?:\/\//i.test(first) || first.includes('.')) {
      const url = ensureUrl(first)
      const slug = (parts[1] ?? stableSlug(url)).replace(/[^a-z0-9_-]/gi, '').slice(0, 40)
      setStoredValue(`${SHORT_PREFIX}${slug}`, url)
      await sendCommandReply(interaction, commandContainer(short, args, flags, summarySection('Shortcut saved', [`-# slug: ${slug}`, `-# note: local bot shortcut, not a public redirect`], { label: 'Open URL', url })))
      return
    }
    const url = getStoredValue(`${SHORT_PREFIX}${first}`)
    await sendCommandReply(interaction, commandContainer(short, args, flags, url ? summarySection(`Shortcut ${first}`, [`-# ${url}`], { label: 'Open URL', url }) : summarySection('Shortcut missing', [`-# no ${first}`])))
  }
}

export const remind: Subcommand = {
  name: 'remind',
  description: 'in memory reminder',
  usage: 'remind <10s|5m|1h|1d> <message> [--pub]',
  examples: ['remind 10m check build'],
  async execute(interaction, args, flags) {
    const shifted = firstToken(restArgs(args))
    const ms = parseDuration(shifted.token)
    if (!ms || !shifted.rest) {
      await sendCommandReply(interaction, commandReferenceReply(remind, args, flags, 'usage', 'bad reminder'))
      return
    }
    const id = scheduleLater(interaction, ms, `Reminder: ${shifted.rest}`)
    await sendCommandReply(interaction, commandContainer(remind, args, flags, summarySection('Reminder scheduled', [`-# id: ${id}`, `-# in: ${formatDuration(ms)}`, '-# in-memory only; restart clears it'])))
  }
}

export const timer: Subcommand = {
  name: 'timer',
  description: 'in memory timer',
  usage: 'timer <10s|5m|1h> [label] [--pub]',
  examples: ['timer 30s tea'],
  async execute(interaction, args, flags) {
    const shifted = firstToken(restArgs(args))
    const ms = parseDuration(shifted.token)
    if (!ms) {
      await sendCommandReply(interaction, commandReferenceReply(timer, args, flags, 'usage', 'bad timer'))
      return
    }
    const label = shifted.rest || 'timer'
    const id = scheduleLater(interaction, ms, `Timer done: ${label}`)
    await sendCommandReply(interaction, commandContainer(timer, args, flags, summarySection('Timer started', [`-# id: ${id}`, `-# ${label}`, `-# in: ${formatDuration(ms)}`, '-# in-memory only; restart clears it'])))
  }
}

export const quote: Subcommand = {
  name: 'quote',
  description: 'save quote',
  usage: 'quote <key> <text> | quote <key> | quote list [--pub]',
  examples: ['quote motto ship it', 'quote motto'],
  async execute(interaction, args, flags) {
    const input = restArgs(args)
    const shifted = firstToken(input)
    if (!shifted.token) {
      await sendCommandReply(interaction, commandReferenceReply(quote, args, flags, 'usage', 'no key'))
      return
    }
    if (shifted.token === 'list') {
      const keys = listStoredKeys().filter((key) => key.startsWith(QUOTE_PREFIX)).map((key) => key.slice(QUOTE_PREFIX.length))
      await sendCommandReply(interaction, commandContainer(quote, args, flags, summarySection('Quotes', keys.length ? keys.map((key) => `-# ${key}`) : ['-# none'])))
      return
    }
    if (shifted.rest) {
      setStoredValue(`${QUOTE_PREFIX}${shifted.token}`, shifted.rest)
      await sendCommandReply(interaction, commandContainer(quote, args, flags, summarySection('Quote saved', [`-# ${shifted.token}`])))
      return
    }
    const value = getStoredValue(`${QUOTE_PREFIX}${shifted.token}`)
    await sendCommandReply(interaction, commandContainer(quote, args, flags, value ? codeBlock(`Quote ${shifted.token}`, value, 'txt') : summarySection('Quote missing', [`-# no ${shifted.token}`])))
  }
}

export const ocr = simpleRerunnable('ocr', 'extract image text', 'ocr <image-url> [--pub]', ['ocr https://example.com/image.png'], async (args) => {
  const result = await openAiOcr(ensureUrl(restArgs(args)))
  return [summarySection('OCR', ['text extracted via OpenAI vision']), separator(), codeBlock('Text', truncate(result, 3500), 'txt')]
})

export const json = simpleRerunnable('json', 'format json', 'json <json> [--pub]', ['json {"ok":true}'], runJson)
export const jwt = simpleRerunnable('jwt', 'decode jwt', 'jwt <token> [--pub]', ['jwt eyJhbGciOiJub25lIn0.eyJzdWIiOiIxMjMifQ.'], runJwt)
export const hash = simpleRerunnable('hash', 'hash text', 'hash <text> [--alg sha256|sha512|md5] [--pub]', ['hash hello', 'hash hello --alg sha512'], runHash, { alg: { description: 'hash algorithm', value: 'string' } })
export const time = simpleRerunnable('time', 'show time', 'time [date] [--pub]', ['time', 'time 2026-05-14T10:00:00+09:00'], async (args) => runTime(args))
export const regex = simpleRerunnable('regex', 'test regex', 'regex <pattern> | <text> [--pub]', ['regex \\d+ | abc 123 def 456'], async (args) => runRegex(args))

export const extraSubcommands = [
  httpdiff,
  headers,
  trace,
  qr,
  short,
  remind,
  timer,
  poll,
  quote,
  ocr,
  json,
  jwt,
  hash,
  time,
  regex
]

export { isPollButtonId, handlePollButton, poll, POLL_BUTTON_ID } from './more-poll.js'
