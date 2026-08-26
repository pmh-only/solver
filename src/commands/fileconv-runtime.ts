import { createCanvas, loadImage } from '@napi-rs/canvas'
import { registerMediabunnyServer } from '@mediabunny/server'
import {
  ADTS,
  AdtsOutputFormat,
  BufferSource,
  BufferTarget,
  Conversion,
  FLAC,
  FlacOutputFormat,
  Input,
  MATROSKA,
  MP3,
  Mp3OutputFormat,
  MP4,
  Mp4OutputFormat,
  MPEG_TS,
  MkvOutputFormat,
  MovOutputFormat,
  MpegTsOutputFormat,
  OGG,
  OggOutputFormat,
  Output,
  QTFF,
  WAVE,
  WavOutputFormat,
  WEBM,
  WebMOutputFormat,
  type OutputFormat
} from 'mediabunny'

registerMediabunnyServer()

export const FILECONV_MAX_INPUT_BYTES = 8 * 1024 * 1024
export const FILECONV_MAX_OUTPUT_BYTES = 8 * 1024 * 1024

const MAX_DIMENSION = 4_096
const MAX_PIXELS = 16_000_000
const MAX_MEDIA_DURATION_SECONDS = 60
const MEDIA_CONVERSION_TIMEOUT_MS = 30_000
const DISCORD_ATTACHMENT_HOSTS = new Set(['cdn.discordapp.com', 'media.discordapp.net'])

export const FILECONV_IMAGE_FORMATS = ['png', 'jpg', 'webp', 'avif', 'gif'] as const
export const FILECONV_AUDIO_FORMATS = ['mp3', 'wav', 'ogg', 'aac', 'flac', 'm4a'] as const
export const FILECONV_VIDEO_FORMATS = ['mp4', 'mov', 'mkv', 'webm', 'ts', 'm4v'] as const
export const FILECONV_FORMATS = [
  ...FILECONV_IMAGE_FORMATS,
  ...FILECONV_AUDIO_FORMATS,
  ...FILECONV_VIDEO_FORMATS
] as const
export type FileconvFormat = (typeof FILECONV_FORMATS)[number]
export type FileconvImageFormat = (typeof FILECONV_IMAGE_FORMATS)[number]

const MEDIA_INPUT_FORMATS = [ADTS, FLAC, MATROSKA, MP3, MP4, MPEG_TS, OGG, QTFF, WAVE, WEBM]

let mediaConversionActive = false

export function parseFileconvFormat(value: string): FileconvFormat | null {
  const normalized = value.trim().toLowerCase()
  if (normalized === 'jpeg') return 'jpg'
  return FILECONV_FORMATS.find((format) => format === normalized) ?? null
}

export function isImageFormat(format: FileconvFormat): format is FileconvImageFormat {
  return FILECONV_IMAGE_FORMATS.some((candidate) => candidate === format)
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

export async function convertImage(input: Buffer, format: FileconvImageFormat): Promise<Buffer> {
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

function mediaOutputFormat(format: Exclude<FileconvFormat, FileconvImageFormat>): OutputFormat {
  switch (format) {
    case 'mp3':
      return new Mp3OutputFormat()
    case 'wav':
      return new WavOutputFormat()
    case 'ogg':
      return new OggOutputFormat()
    case 'aac':
      return new AdtsOutputFormat()
    case 'flac':
      return new FlacOutputFormat()
    case 'm4a':
    case 'mp4':
    case 'm4v':
      return new Mp4OutputFormat()
    case 'mov':
      return new MovOutputFormat()
    case 'mkv':
      return new MkvOutputFormat()
    case 'webm':
      return new WebMOutputFormat()
    case 'ts':
      return new MpegTsOutputFormat()
  }
}

function conversionError(discardedTracks: Conversion['discardedTracks']): Error {
  const reasons = [...new Set(discardedTracks.map((entry) => entry.reason.replaceAll('_', ' ')))]
  return new Error(
    reasons.length > 0
      ? `cannot convert this media: ${reasons.join(', ')}`
      : 'cannot convert this media to the selected format'
  )
}

export async function convertMedia(
  inputBytes: Buffer,
  format: Exclude<FileconvFormat, FileconvImageFormat>
): Promise<Buffer> {
  if (mediaConversionActive)
    throw new Error('another media conversion is running; try again shortly')
  mediaConversionActive = true

  const input = new Input({
    source: new BufferSource(inputBytes),
    formats: MEDIA_INPUT_FORMATS
  })
  let conversion: Conversion | null = null
  let timeout: ReturnType<typeof setTimeout> | null = null

  try {
    if (!(await input.canRead())) throw new Error('file is not a supported audio or video format')
    const duration = await input.computeDuration(undefined, { skipLiveWait: true })
    if (!Number.isFinite(duration) || duration <= 0) throw new Error('media duration is invalid')
    if (duration > MAX_MEDIA_DURATION_SECONDS) {
      throw new Error('audio and video files must be 60 seconds or shorter')
    }

    const target = new BufferTarget()
    target.on('write', ({ end }) => {
      if (end > FILECONV_MAX_OUTPUT_BYTES) {
        throw new Error('converted file is too large (8 MB maximum)')
      }
    })
    const output = new Output({ format: mediaOutputFormat(format), target })
    conversion = await Conversion.init({
      input,
      output,
      tracks: 'primary',
      video: FILECONV_AUDIO_FORMATS.some((candidate) => candidate === format)
        ? { discard: true }
        : undefined,
      showWarnings: false
    })
    if (!conversion.isValid || conversion.utilizedTracks.length === 0) {
      throw conversionError(conversion.discardedTracks)
    }

    const timeoutPromise = new Promise<never>((_, reject) => {
      timeout = setTimeout(() => {
        void conversion?.cancel()
        reject(new Error('media conversion timed out'))
      }, MEDIA_CONVERSION_TIMEOUT_MS)
      timeout.unref?.()
    })
    await Promise.race([conversion.execute(), timeoutPromise])

    if (!target.buffer) throw new Error('media conversion produced no file')
    const result = Buffer.from(target.buffer)
    if (result.byteLength > FILECONV_MAX_OUTPUT_BYTES) {
      throw new Error('converted file is too large (8 MB maximum)')
    }
    return result
  } catch (error) {
    if (conversion && conversion.state !== 'done' && conversion.state !== 'canceled') {
      await conversion.cancel().catch(() => {})
    }
    if (error instanceof Error && error.message.startsWith('cannot convert')) throw error
    if (
      error instanceof Error &&
      (error.message.includes('60 seconds') ||
        error.message.includes('timed out') ||
        error.message.includes('too large') ||
        error.message.includes('supported audio or video'))
    ) {
      throw error
    }
    throw new Error('cannot convert this media to the selected format')
  } finally {
    if (timeout) clearTimeout(timeout)
    input.dispose()
    mediaConversionActive = false
  }
}
