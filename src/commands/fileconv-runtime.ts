import { createCanvas, loadImage } from '@napi-rs/canvas'

export const FILECONV_MAX_INPUT_BYTES = 8 * 1024 * 1024
export const FILECONV_MAX_OUTPUT_BYTES = 8 * 1024 * 1024

const MAX_DIMENSION = 4_096
const MAX_PIXELS = 16_000_000
const DISCORD_ATTACHMENT_HOSTS = new Set(['cdn.discordapp.com', 'media.discordapp.net'])

export const FILECONV_FORMATS = ['png', 'jpg', 'webp', 'avif', 'gif'] as const
export type FileconvFormat = (typeof FILECONV_FORMATS)[number]

export function parseFileconvFormat(value: string): FileconvFormat | null {
  const normalized = value.trim().toLowerCase()
  if (normalized === 'jpeg') return 'jpg'
  return FILECONV_FORMATS.find((format) => format === normalized) ?? null
}

export function convertedFileName(sourceName: string, format: FileconvFormat): string {
  const base = sourceName
    .replace(/\.[^.]*$/, '')
    .replace(/[^a-zA-Z0-9._-]/g, '_')
    .slice(0, 80)
  return `${base || 'converted'}.${format}`
}

export async function downloadDiscordAttachment(url: string): Promise<Buffer> {
  const parsed = new URL(url)
  if (parsed.protocol !== 'https:' || !DISCORD_ATTACHMENT_HOSTS.has(parsed.hostname)) {
    throw new Error('invalid attachment URL')
  }

  const response = await fetch(parsed, {
    redirect: 'error',
    signal: AbortSignal.timeout(10_000)
  })
  if (!response.ok) throw new Error(`could not download file (${response.status})`)

  const declaredLength = Number(response.headers.get('content-length'))
  if (Number.isFinite(declaredLength) && declaredLength > FILECONV_MAX_INPUT_BYTES) {
    throw new Error('file is too large (8 MB maximum)')
  }
  if (!response.body) throw new Error('file download had no body')

  const chunks: Buffer[] = []
  let size = 0
  const reader = response.body.getReader()
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      size += value.byteLength
      if (size > FILECONV_MAX_INPUT_BYTES) {
        await reader.cancel()
        throw new Error('file is too large (8 MB maximum)')
      }
      chunks.push(Buffer.from(value))
    }
  } finally {
    reader.releaseLock()
  }

  return Buffer.concat(chunks) as Buffer
}

export async function convertImage(input: Buffer, format: FileconvFormat): Promise<Buffer> {
  let image
  try {
    image = await loadImage(input)
  } catch {
    throw new Error('file is not a supported image')
  }

  if (
    image.width < 1 ||
    image.height < 1 ||
    image.width > MAX_DIMENSION ||
    image.height > MAX_DIMENSION ||
    image.width * image.height > MAX_PIXELS
  ) {
    throw new Error('image dimensions exceed 4096 px or 16 megapixels')
  }

  const canvas = createCanvas(image.width, image.height)
  const context = canvas.getContext('2d')
  if (format === 'jpg') {
    context.fillStyle = '#ffffff'
    context.fillRect(0, 0, image.width, image.height)
  }
  context.drawImage(image, 0, 0)

  const output =
    format === 'jpg'
      ? await canvas.encode('jpeg', 90)
      : format === 'webp'
        ? await canvas.encode('webp', 90)
        : format === 'avif'
          ? await canvas.encode('avif', { quality: 90 })
          : format === 'gif'
            ? await canvas.encode('gif', 90)
            : await canvas.encode('png')

  if (output.byteLength > FILECONV_MAX_OUTPUT_BYTES) {
    throw new Error('converted file is too large (8 MB maximum)')
  }
  return output
}
