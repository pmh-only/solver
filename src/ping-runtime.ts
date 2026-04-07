import { request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { createHmac, createCipheriv, randomBytes } from 'node:crypto'
import { createSocket } from 'node:dgram'
import { isIP } from 'node:net'

const TIMEOUT_MS = 3000
export const DEFAULT_PING_COUNT = 3
const DEFAULT_TYPES = ['icmp', 'http', 'https', 'http3'] as const

export type PingType = (typeof DEFAULT_TYPES)[number]

interface PingProbeRequest {
  host: string
  count: number
  types: PingType[]
}

interface PingSummary {
  type: PingType
  count: number
  ms: number[]
  error?: string
  note?: string
}

export interface PingReport {
  host: string
  count: number
  types: PingType[]
  summaries: PingSummary[]
}

export function parsePingTypes(value: string | undefined): PingType[] | { error: string } {
  if (!value) return [...DEFAULT_TYPES]

  const types = value
    .split(',')
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean)

  if (types.length === 0) return [...DEFAULT_TYPES]

  const invalid = types.filter((type): type is string => !DEFAULT_TYPES.includes(type as PingType))
  if (invalid.length > 0) {
    return { error: `bad type: ${invalid.join(',')}` }
  }

  return [...new Set(types)] as PingType[]
}

function parseTarget(input: string): URL {
  try {
    return new URL(input.includes('://') ? input : `https://${input}`)
  } catch {
    throw new Error(`bad host: ${input}`)
  }
}

function formatMs(value: number): string {
  return `${value.toFixed(1)}ms`
}

function summarize(
  type: PingType,
  count: number,
  ms: number[],
  error?: string,
  note?: string
): PingSummary {
  return { type, count, ms, error, note }
}

function requestOnce(url: URL, insecureTls = false): Promise<number> {
  const requestImpl = url.protocol === 'https:' ? httpsRequest : httpRequest

  return new Promise((resolve, reject) => {
    const started = performance.now()
    const req = requestImpl(
      url,
      {
        method: 'GET',
        timeout: TIMEOUT_MS,
        rejectUnauthorized: insecureTls ? false : undefined,
        servername: isIP(url.hostname) ? undefined : url.hostname
      },
      (res) => {
        res.resume()
        resolve(performance.now() - started)
      }
    )

    req.on('timeout', () => {
      req.destroy(new Error('timeout'))
    })
    req.on('error', reject)
    req.end()
  })
}

const QUIC_V1_SALT = Buffer.from('38762cf7f55934b34d179ae6a4c80cadccbb7f0a', 'hex')

function hmac256(key: Buffer, ...parts: Buffer[]): Buffer {
  const hmac = createHmac('sha256', key)
  for (const part of parts) hmac.update(part)
  return hmac.digest() as Buffer
}

function hkdfExpand(prk: Buffer, info: Buffer, len: number): Buffer {
  const out: Buffer[] = []
  let block = Buffer.alloc(0) as Buffer

  while (out.reduce((size, entry) => size + entry.length, 0) < len) {
    block = hmac256(prk, block, info, Buffer.from([out.length + 1])) as Buffer
    out.push(block)
  }

  return Buffer.concat(out) as Buffer
}

function expandLabel(prk: Buffer, label: string, len: number): Buffer {
  const encodedLabel = Buffer.from(`tls13 ${label}`)
  return hkdfExpand(
    prk,
    Buffer.concat([
      Buffer.from([0, len, encodedLabel.length]),
      encodedLabel,
      Buffer.from([0])
    ]) as Buffer,
    len
  ).subarray(0, len)
}

function buildClientHello(serverName: string | null): Buffer {
  const exts: Buffer[] = []

  if (serverName) {
    const hostname = Buffer.from(serverName)
    exts.push(
      Buffer.concat([
        Buffer.from([0x00, 0x00]),
        Buffer.from([0x00, hostname.length + 5]),
        Buffer.from([0x00, hostname.length + 3]),
        Buffer.from([0x00]),
        Buffer.from([0x00, hostname.length]),
        hostname
      ]) as Buffer
    )
  }

  exts.push(Buffer.from([0x00, 0x2b, 0x00, 0x03, 0x02, 0x03, 0x04]))
  exts.push(Buffer.from([0x00, 0x0a, 0x00, 0x04, 0x00, 0x02, 0x00, 0x1d]))

  const keyShare = randomBytes(32)
  exts.push(
    Buffer.concat([
      Buffer.from([0x00, 0x33, 0x00, 38, 0x00, 36, 0x00, 0x1d, 0x00, 32]),
      keyShare
    ]) as Buffer
  )
  exts.push(Buffer.from([0x00, 0x39, 0x00, 0x00]))

  const extData = Buffer.concat(exts) as Buffer
  const body = Buffer.concat([
    Buffer.from([0x03, 0x03]),
    randomBytes(32),
    Buffer.from([0x00]),
    Buffer.from([0x00, 0x02, 0x13, 0x01]),
    Buffer.from([0x01, 0x00]),
    Buffer.from([0x00, extData.length]),
    extData
  ]) as Buffer

  return Buffer.concat([
    Buffer.from([0x01, 0x00, body.length >> 8, body.length & 0xff]),
    body
  ]) as Buffer
}

function quicVarInt2(n: number): Buffer {
  return Buffer.from([0x40 | (n >> 8), n & 0xff])
}

function buildQuicProbe(host: string): Buffer {
  const dcid = randomBytes(8)
  const clientSecret = expandLabel(hmac256(QUIC_V1_SALT, dcid), 'client in', 32)
  const key = expandLabel(clientSecret, 'quic key', 16)
  const iv = expandLabel(clientSecret, 'quic iv', 12)
  const hp = expandLabel(clientSecret, 'quic hp', 16)

  const clientHello = buildClientHello(isIP(host) ? null : host)
  const helloLen =
    clientHello.length < 64 ? Buffer.from([clientHello.length]) : quicVarInt2(clientHello.length)
  const cryptoFrame = Buffer.concat([Buffer.from([0x06, 0x00]), helloLen, clientHello]) as Buffer
  const padded = Buffer.concat([
    cryptoFrame,
    Buffer.alloc(Math.max(0, 1162 - cryptoFrame.length), 0x00)
  ]) as Buffer

  const packetNumber = Buffer.from([0x00, 0x00, 0x00, 0x00])
  const remainingLength = packetNumber.length + padded.length + 16
  const header = Buffer.concat([
    Buffer.from([0xc3]),
    Buffer.from([0x00, 0x00, 0x00, 0x01]),
    Buffer.from([dcid.length]),
    dcid,
    Buffer.from([0x00, 0x00]),
    quicVarInt2(remainingLength),
    packetNumber
  ]) as Buffer

  const nonce = Buffer.from(iv)
  const packetValue = packetNumber.readUInt32BE(0)
  for (let i = 0; i < 4; i++) nonce[8 + i] ^= (packetValue >> (24 - 8 * i)) & 0xff

  const cipher = createCipheriv('aes-128-gcm', key, nonce)
  cipher.setAAD(header)
  const encrypted = Buffer.concat([cipher.update(padded), cipher.final()]) as Buffer
  const tag = cipher.getAuthTag()
  const mask = createCipheriv('aes-128-ecb', hp, null).update(encrypted.subarray(0, 16))

  const protectedPacketNumber = Buffer.alloc(4)
  for (let i = 0; i < 4; i++) protectedPacketNumber[i] = packetNumber[i] ^ mask[1 + i]

  return Buffer.concat([
    Buffer.from([header[0] ^ (mask[0] & 0x0f)]),
    header.subarray(1, header.length - 4),
    protectedPacketNumber,
    encrypted,
    tag
  ]) as Buffer
}

function http3Once(host: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const socket = createSocket(isIP(host) === 6 ? 'udp6' : 'udp4')
    const started = performance.now()
    const timer = setTimeout(() => {
      socket.close()
      reject(new Error('timeout'))
    }, TIMEOUT_MS)

    socket.once('message', () => {
      clearTimeout(timer)
      resolve(performance.now() - started)
      socket.close()
    })

    socket.once('error', (error) => {
      clearTimeout(timer)
      try {
        socket.close()
      } catch {
        // ignore close races
      }
      reject(error)
    })

    socket.send(buildQuicProbe(host), 443, host, (error) => {
      if (!error) return
      clearTimeout(timer)
      try {
        socket.close()
      } catch {
        // ignore close races
      }
      reject(error)
    })
  })
}

async function runProbe(
  count: number,
  once: () => Promise<number>
): Promise<{ ms: number[]; error?: string }> {
  const settled = await Promise.allSettled(Array.from({ length: count }, once))
  const ms = settled
    .filter((result): result is PromiseFulfilledResult<number> => result.status === 'fulfilled')
    .map((result) => result.value)
  const rejected = settled.find(
    (result): result is PromiseRejectedResult => result.status === 'rejected'
  )
  return { ms, error: rejected?.reason instanceof Error ? rejected.reason.message : 'err' }
}

export async function probePingTarget(request: PingProbeRequest): Promise<PingReport> {
  const target = parseTarget(request.host)
  const httpUrl = new URL(target.toString())
  httpUrl.protocol = 'http:'
  if (!httpUrl.port) httpUrl.port = '80'

  const httpsUrl = new URL(target.toString())
  httpsUrl.protocol = 'https:'
  if (!httpsUrl.port) httpsUrl.port = '443'

  const summaries: PingSummary[] = []

  for (const type of request.types) {
    if (type === 'icmp') {
      summaries.push(summarize(type, request.count, [], undefined, 'no icmp'))
      continue
    }

    if (type === 'http') {
      const result = await runProbe(request.count, () => requestOnce(httpUrl))
      summaries.push(summarize(type, request.count, result.ms, result.error))
      continue
    }

    if (type === 'https') {
      const result = await runProbe(request.count, () => requestOnce(httpsUrl, true))
      summaries.push(summarize(type, request.count, result.ms, result.error))
      continue
    }

    const result = await runProbe(request.count, () => http3Once(target.hostname))
    summaries.push(summarize(type, request.count, result.ms, result.error, 'quic'))
  }

  return {
    host: request.host,
    count: request.count,
    types: request.types,
    summaries
  }
}

export function formatPingReport(report: PingReport): string {
  const lines = [`**${report.host}**`, `-# cnt=${report.count} type=${report.types.join(',')}`]

  for (const summary of report.summaries) {
    if (summary.note && summary.ms.length === 0) {
      lines.push(`-# ${summary.type}: ${summary.note}`)
      continue
    }

    if (summary.ms.length === 0) {
      lines.push(`-# ${summary.type}: ${summary.error ?? 'err'}`)
      continue
    }

    const min = Math.min(...summary.ms)
    const avg = summary.ms.reduce((total, value) => total + value, 0) / summary.ms.length
    const max = Math.max(...summary.ms)
    const loss =
      summary.ms.length < summary.count
        ? ` loss=${summary.count - summary.ms.length}/${summary.count}`
        : ''
    const note = summary.note ? ` (${summary.note})` : ''
    lines.push(
      `-# ${summary.type}: min=${formatMs(min)} avg=${formatMs(avg)} max=${formatMs(max)}${loss}${note}`
    )
  }

  return lines.join('\n')
}
