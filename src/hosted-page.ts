import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { randomUUID } from 'node:crypto'

export const HOSTED_HTML_PATH = join(process.cwd(), 'data', 'hosted.html')
export const MAX_HOSTED_HTML_BYTES = 1024 * 1024

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

export function hostedPageUrl(): string | null {
  const domain = process.env.WEB_DOMAIN?.trim()
  if (!domain) return null
  const origin = /^https?:\/\//i.test(domain) ? domain : `https://${domain}`
  return new URL('/hosted', origin).href
}
