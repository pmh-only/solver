type CurrencyRequest = {
  kind: 'currency'
  amount: number
  from: string
  to: string
}

type NumberBase = 'bin' | 'oct' | 'dec' | 'hex'
type ByteEncoding = 'utf8' | 'base64' | 'hex'

type NumberRequest = {
  kind: 'number'
  input: string
  from: NumberBase
  to: NumberBase
}

type BytesRequest = {
  kind: 'bytes'
  input: string
  from: ByteEncoding
  to: ByteEncoding
}

export type ConvRequest = CurrencyRequest | NumberRequest | BytesRequest

const numberBases = new Set<NumberBase>(['bin', 'oct', 'dec', 'hex'])
const byteEncodings = new Set<ByteEncoding>(['utf8', 'base64', 'hex'])

function normalizeUnit(unit: string | undefined): string | null {
  if (!unit) return null
  const normalized = unit.trim().toLowerCase()

  switch (normalized) {
    case 'text':
    case 'string':
    case 'utf-8':
    case 'utf8':
      return 'utf8'
    case 'b64':
    case 'base64':
      return 'base64'
    case 'binary':
    case 'bin':
      return 'bin'
    case 'octal':
    case 'oct':
      return 'oct'
    case 'decimal':
    case 'dec':
      return 'dec'
    default:
      return normalized
  }
}

function isCurrencyCode(unit: string | null): unit is string {
  return unit !== null && /^[a-z]{3}$/.test(unit) && !numberBases.has(unit as NumberBase)
}

function isNumberBase(unit: string | null): unit is NumberBase {
  return unit !== null && numberBases.has(unit as NumberBase)
}

function isByteEncoding(unit: string | null): unit is ByteEncoding {
  return unit !== null && byteEncodings.has(unit as ByteEncoding)
}

function parseAmount(value: string): number {
  const amount = Number(value)
  if (!Number.isFinite(amount)) throw new Error('bad num')
  return amount
}

function parseCurrencyInput(input: string): { amount: number; from: string } {
  const compact = input.trim().match(/^([+-]?(?:\d+(?:\.\d+)?|\.\d+))\s*([a-z]{3})$/i)
  if (!compact) throw new Error('bad conv')
  return { amount: parseAmount(compact[1]), from: compact[2].toUpperCase() }
}

function isValidDigits(input: string, base: NumberBase): boolean {
  const value = input.trim()
  if (!/^[+-]?[0-9a-f]+$/i.test(value)) return false

  const digits = value.replace(/^[+-]/, '')
  if (digits.length === 0) return false

  switch (base) {
    case 'bin':
      return /^[01]+$/.test(digits)
    case 'oct':
      return /^[0-7]+$/.test(digits)
    case 'dec':
      return /^\d+$/.test(digits)
    case 'hex':
      return /^[0-9a-f]+$/i.test(digits)
  }
}

function parseBaseInt(input: string, base: NumberBase): bigint {
  const trimmed = input.trim()
  if (!isValidDigits(trimmed, base)) throw new Error(`bad ${base}`)

  const sign = trimmed.startsWith('-') ? -1n : 1n
  const digits = trimmed.replace(/^[+-]/, '')
  const prefix = base === 'bin' ? '0b' : base === 'oct' ? '0o' : base === 'hex' ? '0x' : ''
  const value = BigInt(prefix + digits)
  return sign < 0 ? -value : value
}

function formatBaseInt(value: bigint, base: NumberBase): string {
  const sign = value < 0 ? '-' : ''
  const abs = value < 0 ? -value : value

  switch (base) {
    case 'bin':
      return sign + abs.toString(2)
    case 'oct':
      return sign + abs.toString(8)
    case 'dec':
      return sign + abs.toString(10)
    case 'hex':
      return sign + abs.toString(16)
  }
}

function decodeBytes(input: string, encoding: ByteEncoding): Buffer {
  switch (encoding) {
    case 'utf8':
      return Buffer.from(input, 'utf8')
    case 'hex': {
      const normalized = input.trim()
      if (!/^(?:[0-9a-fA-F]{2})*$/.test(normalized)) throw new Error('bad hex')
      return Buffer.from(normalized, 'hex')
    }
    case 'base64': {
      const normalized = input.trim()
      if (!/^[A-Za-z0-9+/]*={0,2}$/.test(normalized) || normalized.length % 4 === 1) {
        throw new Error('bad b64')
      }
      return Buffer.from(normalized, 'base64')
    }
  }
}

function encodeBytes(bytes: Buffer, encoding: ByteEncoding): string {
  switch (encoding) {
    case 'utf8':
      return bytes.toString('utf8')
    case 'hex':
      return bytes.toString('hex')
    case 'base64':
      return bytes.toString('base64')
  }
}

function parseRequest(input: string): ConvRequest {
  const trimmed = input.trim()
  if (!trimmed) throw new Error('no args')

  const fromMatch = trimmed.match(/^(.*?)\s+from\s+(\S+)(?:\s+to\s+(\S+))?$/i)
  if (fromMatch) {
    const source = fromMatch[1].trim()
    const from = normalizeUnit(fromMatch[2])
    const to = normalizeUnit(fromMatch[3])

    if (isCurrencyCode(from) && isCurrencyCode(to)) {
      return {
        kind: 'currency',
        amount: parseAmount(source),
        from: from.toUpperCase(),
        to: to.toUpperCase()
      }
    }

    if (isNumberBase(from) && (!to || isNumberBase(to)) && isValidDigits(source, from)) {
      return { kind: 'number', input: source, from, to: (to ?? 'dec') as NumberBase }
    }

    if (isByteEncoding(from) && (!to || isByteEncoding(to))) {
      return { kind: 'bytes', input: source, from, to: (to ?? 'utf8') as ByteEncoding }
    }

    throw new Error('bad conv')
  }

  const toMatch = trimmed.match(/^(.*?)\s+to\s+(\S+)$/i)
  if (toMatch) {
    const source = toMatch[1].trim()
    const to = normalizeUnit(toMatch[2])

    if (isCurrencyCode(to)) {
      const parsed = parseCurrencyInput(source)
      return { kind: 'currency', amount: parsed.amount, from: parsed.from, to: to.toUpperCase() }
    }

    if (isNumberBase(to) && /^[-+]?\d+$/.test(source)) {
      return { kind: 'number', input: source, from: 'dec', to }
    }

    if (isByteEncoding(to)) {
      return { kind: 'bytes', input: source, from: 'utf8', to }
    }

    throw new Error('bad conv')
  }

  throw new Error('bad conv')
}

function formatNumber(value: number): string {
  if (Number.isInteger(value)) return String(value)
  return value
    .toFixed(6)
    .replace(/\.0+$/, '')
    .replace(/(\.\d*?)0+$/, '$1')
}

async function convertCurrency(request: CurrencyRequest): Promise<string> {
  const url = new URL('https://api.frankfurter.app/latest')
  url.searchParams.set('amount', String(request.amount))
  url.searchParams.set('from', request.from)
  url.searchParams.set('to', request.to)

  const response = await fetch(url)
  if (!response.ok) throw new Error(`fx err: ${response.status}`)

  const data = (await response.json()) as { rates?: Record<string, number> }
  const rate = data.rates?.[request.to]
  if (typeof rate !== 'number' || !Number.isFinite(rate)) throw new Error('no rate')

  return `${formatNumber(request.amount)} ${request.from} = ${formatNumber(rate)} ${request.to}`
}

function convertNumber(request: NumberRequest): string {
  const value = parseBaseInt(request.input, request.from)
  return formatBaseInt(value, request.to)
}

function convertBytes(request: BytesRequest): string {
  const bytes = decodeBytes(request.input, request.from)
  return encodeBytes(bytes, request.to)
}

export function inspectConvRequest(input: string): ConvRequest {
  return parseRequest(input)
}

export async function convertValue(input: string): Promise<string> {
  const request = parseRequest(input)

  switch (request.kind) {
    case 'currency':
      return convertCurrency(request)
    case 'number':
      return convertNumber(request)
    case 'bytes':
      return convertBytes(request)
  }
}
