import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { randomUUID } from 'node:crypto'

export const HOSTED_HTML_PATH = join(process.cwd(), 'data', 'hosted.html')
export const SHARED_HTML_DIRECTORY = join(process.cwd(), 'data', 'shared')
export const MAX_HOSTED_HTML_BYTES = 1024 * 1024
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

export async function readHostedHtml(path = HOSTED_HTML_PATH): Promise<string | null> {
  try {
    return await readFile(path, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
}

export async function writeHostedHtml(html: string, path = HOSTED_HTML_PATH): Promise<void> {
  const size = Buffer.byteLength(html)
  if (size === 0) throw new Error('HTML must not be empty.')
  if (size > MAX_HOSTED_HTML_BYTES) throw new Error('HTML must not exceed 1 MiB.')

  await mkdir(dirname(path), { recursive: true })
  const temporaryPath = `${path}.${randomUUID()}.tmp`
  try {
    await writeFile(temporaryPath, html, { encoding: 'utf8', mode: 0o644 })
    await rename(temporaryPath, path)
  } finally {
    await rm(temporaryPath, { force: true })
  }
}

export async function writeSharedHtml(html: string): Promise<string> {
  const id = randomUUID()
  await writeHostedHtml(html, join(SHARED_HTML_DIRECTORY, `${id}.html`))
  return id
}

export async function readSharedHtml(id: string): Promise<string | null> {
  if (!UUID_PATTERN.test(id)) return null
  return readHostedHtml(join(SHARED_HTML_DIRECTORY, `${id}.html`))
}

function webUrl(path: string): string | null {
  const domain = process.env.WEB_DOMAIN?.trim()
  if (!domain) return null
  const origin = /^https?:\/\//i.test(domain) ? domain : `https://${domain}`
  return new URL(path, origin).href
}

export function hostedPageUrl(): string | null {
  return webUrl('/hosted')
}

export function sharedPageUrl(id: string): string | null {
  if (!UUID_PATTERN.test(id)) return null
  return webUrl(`/shared/${id}`)
}
