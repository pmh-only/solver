import type { Attachment } from 'discord.js'
import type { ContentBlockData, DocumentFormat, ImageFormat } from '@strands-agents/sdk'

export const MAX_AGENT_ATTACHMENT_BYTES = 10 * 1024 * 1024

const IMAGE_TYPES = new Map<string, ImageFormat>([
  ['image/png', 'png'],
  ['image/jpeg', 'jpeg'],
  ['image/gif', 'gif'],
  ['image/webp', 'webp']
])
const DOCUMENT_TYPES = new Map<string, DocumentFormat>([
  ['application/pdf', 'pdf'],
  ['text/csv', 'csv'],
  ['application/msword', 'doc'],
  ['application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'docx'],
  ['application/vnd.ms-excel', 'xls'],
  ['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'xlsx'],
  ['text/html', 'html'],
  ['text/plain', 'txt'],
  ['text/markdown', 'md'],
  ['application/json', 'json'],
  ['application/xml', 'xml'],
  ['text/xml', 'xml']
])
const EXTENSION_FORMATS = new Map<string, ImageFormat | DocumentFormat>([
  ['png', 'png'],
  ['jpg', 'jpeg'],
  ['jpeg', 'jpeg'],
  ['gif', 'gif'],
  ['webp', 'webp'],
  ...['pdf', 'csv', 'doc', 'docx', 'xls', 'xlsx', 'html', 'txt', 'md', 'json', 'xml'].map(
    (format) => [format, format] as [string, DocumentFormat]
  )
])
const DISCORD_ATTACHMENT_HOSTS = new Set(['cdn.discordapp.com', 'media.discordapp.net'])

export interface AgentAttachmentInput {
  displayName: string
  content: ContentBlockData
}

function attachmentType(contentType: string | null, filename: string) {
  const mime = contentType?.split(';', 1)[0]?.trim().toLowerCase() ?? ''
  const format = IMAGE_TYPES.get(mime) ?? DOCUMENT_TYPES.get(mime)
  const extension = filename.match(/\.([a-z0-9]+)$/i)?.[1]?.toLowerCase()
  const extensionFormat = extension ? EXTENSION_FORMATS.get(extension) : undefined

  if (!format || !extensionFormat || format !== extensionFormat) {
    throw new Error(
      'attachment type is unsupported or does not match its filename; use PNG, JPEG, GIF, WebP, PDF, CSV, Word, Excel, HTML, text, Markdown, JSON, or XML'
    )
  }
  return { format, image: IMAGE_TYPES.has(mime) }
}

export function safeAttachmentName(filename: string, format: ImageFormat | DocumentFormat): string {
  const leaf = filename.split(/[\\/]/).at(-1) ?? ''
  const stem = leaf
    .replace(/\.[^.]*$/, '')
    .replace(/[^a-zA-Z0-9_-]+/g, '_')
    .replace(/^_+|_+$/g, '')
  return `${(stem || 'attachment').slice(0, 80)}.${format === 'jpeg' ? 'jpg' : format}`
}

function validateAttachmentUrl(value: string): URL {
  const url = new URL(value)
  if (url.protocol !== 'https:' || !DISCORD_ATTACHMENT_HOSTS.has(url.hostname)) {
    throw new Error('attachment URL is not a trusted Discord CDN URL')
  }
  return url
}

async function readBoundedBody(response: Response): Promise<Uint8Array> {
  if (!response.body) throw new Error('attachment download returned no data')
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      size += value.byteLength
      if (size > MAX_AGENT_ATTACHMENT_BYTES) throw new Error('attachment exceeds the 10 MiB limit')
      chunks.push(value)
    }
  } catch (error) {
    await reader.cancel().catch(() => {})
    throw error
  }

  const bytes = new Uint8Array(size)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  return bytes
}

export async function receiveAgentAttachment(
  attachment: Pick<Attachment, 'name' | 'size' | 'contentType' | 'url'>
): Promise<AgentAttachmentInput> {
  if (attachment.size <= 0) throw new Error('attachment is empty')
  if (attachment.size > MAX_AGENT_ATTACHMENT_BYTES)
    throw new Error('attachment exceeds the 10 MiB limit')

  const { format, image } = attachmentType(attachment.contentType, attachment.name)
  const displayName = safeAttachmentName(attachment.name, format)
  const response = await fetch(validateAttachmentUrl(attachment.url), {
    redirect: 'error',
    signal: AbortSignal.timeout(10_000)
  })
  if (!response.ok) throw new Error(`attachment download failed (${response.status})`)

  const responseType = response.headers.get('content-type')
  if (responseType && responseType !== 'application/octet-stream') {
    attachmentType(responseType, displayName)
  }
  const bytes = await readBoundedBody(response)
  if (bytes.byteLength !== attachment.size)
    throw new Error('attachment size changed during download')

  return {
    displayName,
    content: image
      ? { image: { format: format as ImageFormat, source: { bytes } } }
      : {
          document: {
            name: displayName,
            format: format as DocumentFormat,
            source: { bytes }
          }
        }
  }
}
