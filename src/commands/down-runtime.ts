import { lookup } from 'node:dns/promises'
import { BlockList, isIP } from 'node:net'

export const DOWN_MAX_BYTES = 10 * 1024 * 1024

const MAX_REDIRECTS = 5
const TIMEOUT_MS = 15_000
const privateAddresses = new BlockList()

for (const [address, prefix] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4]
] as const) {
  privateAddresses.addSubnet(address, prefix, 'ipv4')
}

for (const [address, prefix] of [
  ['::', 128],
  ['::1', 128],
  ['fc00::', 7],
  ['fe80::', 10],
  ['ff00::', 8],
  ['2001:db8::', 32]
] as const) {
  privateAddresses.addSubnet(address, prefix, 'ipv6')
}

interface Address {
  address: string
  family: number
}

interface DownloadDependencies {
  fetch: typeof fetch
  lookup: (hostname: string) => Promise<Address[]>
  timeoutMs?: number
}

export interface DownloadedFile {
  data: Buffer
  fileName: string
  finalUrl: string
  contentType: string
}

const defaultDependencies: DownloadDependencies = {
  fetch,
  lookup: async (hostname) => await lookup(hostname, { all: true, verbatim: true })
}

let activeDownloads = 0

function mappedIpv4(address: string): string | null {
  const match = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address)
  return match?.[1] ?? null
}

function isBlockedAddress(address: string): boolean {
  const mapped = mappedIpv4(address)
  if (mapped) return privateAddresses.check(mapped, 'ipv4')
  const family = isIP(address)
  return family === 4
    ? privateAddresses.check(address, 'ipv4')
    : family === 6
      ? privateAddresses.check(address, 'ipv6')
      : true
}

function parseDownloadUrl(value: string): URL {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new Error('invalid URL')
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new Error('only HTTP and HTTPS URLs are supported')
  }
  if (url.username || url.password) throw new Error('URLs with credentials are not supported')
  return url
}

async function validatePublicDestination(url: URL, dependencies: DownloadDependencies) {
  if (url.hostname.toLowerCase() === 'localhost') throw new Error('private URLs are not allowed')
  const hostname = url.hostname.replace(/^\[|\]$/g, '')
  const literalFamily = isIP(hostname)
  const addresses = literalFamily
    ? [{ address: hostname, family: literalFamily }]
    : await dependencies.lookup(hostname)
  if (addresses.length === 0) throw new Error('URL host did not resolve')
  if (addresses.some(({ address }) => isBlockedAddress(address))) {
    throw new Error('private URLs are not allowed')
  }
}

function sanitizeFileName(value: string): string {
  const sanitized = value
    .replace(/[\\/]/g, '_')
    .replace(/[^a-zA-Z0-9._ -]/g, '_')
    .replace(/^\.+/, '')
    .trim()
    .slice(0, 100)
  return sanitized || 'download.bin'
}

function contentDispositionFileName(value: string | null): string | null {
  if (!value) return null
  const encoded = /filename\*\s*=\s*UTF-8''([^;]+)/i.exec(value)?.[1]
  if (encoded) {
    try {
      return decodeURIComponent(encoded.trim())
    } catch {
      return null
    }
  }
  return (
    /filename\s*=\s*"([^"]+)"/i.exec(value)?.[1] ??
    /filename\s*=\s*([^;]+)/i.exec(value)?.[1]?.trim() ??
    null
  )
}

function responseFileName(response: Response, url: URL): string {
  const disposition = contentDispositionFileName(response.headers.get('content-disposition'))
  if (disposition) return sanitizeFileName(disposition)
  const segment = url.pathname.split('/').filter(Boolean).at(-1)
  if (segment) {
    try {
      return sanitizeFileName(decodeURIComponent(segment))
    } catch {
      return sanitizeFileName(segment)
    }
  }
  return 'download.bin'
}

async function readBoundedBody(response: Response): Promise<Buffer> {
  const declared = Number(response.headers.get('content-length'))
  if (Number.isFinite(declared) && declared > DOWN_MAX_BYTES) {
    await response.body?.cancel()
    throw new Error('file is larger than 10 MB')
  }
  if (!response.body) throw new Error('download returned no file data')

  const reader = response.body.getReader()
  const chunks: Buffer[] = []
  let total = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      total += value.byteLength
      if (total > DOWN_MAX_BYTES) {
        await reader.cancel()
        throw new Error('file is larger than 10 MB')
      }
      chunks.push(Buffer.from(value))
    }
  } finally {
    reader.releaseLock()
  }
  return Buffer.concat(chunks) as Buffer
}

export async function downloadUrl(
  value: string,
  dependencies: DownloadDependencies = defaultDependencies
): Promise<DownloadedFile> {
  const initialUrl = parseDownloadUrl(value)
  if (activeDownloads >= 2) throw new Error('too many downloads are running; try again shortly')
  activeDownloads++

  const signal = AbortSignal.timeout(dependencies.timeoutMs ?? TIMEOUT_MS)
  let current = initialUrl
  try {
    for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects++) {
      await validatePublicDestination(current, dependencies)
      const response = await dependencies.fetch(current, { redirect: 'manual', signal })
      const location = response.headers.get('location')
      if (response.status >= 300 && response.status < 400 && location) {
        await response.body?.cancel()
        if (redirects === MAX_REDIRECTS) throw new Error('too many redirects')
        current = parseDownloadUrl(new URL(location, current).toString())
        continue
      }
      if (!response.ok) {
        await response.body?.cancel()
        throw new Error(`download failed (${response.status})`)
      }

      return {
        data: await readBoundedBody(response),
        fileName: responseFileName(response, current),
        finalUrl: current.toString(),
        contentType: response.headers.get('content-type') ?? 'application/octet-stream'
      }
    }
    throw new Error('too many redirects')
  } finally {
    activeDownloads--
  }
}

export function safeDownloadLabel(value: string): string {
  try {
    return new URL(value).hostname || 'file'
  } catch {
    return 'file'
  }
}
