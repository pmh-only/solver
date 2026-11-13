import { createHash } from 'node:crypto'
import type { Attachment, Message } from 'discord.js'
import type { ModerationCreateParams } from 'openai/resources/moderations.js'

export type ModerationInput = ModerationCreateParams['input']
export function moderationSnapshot(message: Message) {
  const attachments = [...message.attachments.values()].slice(0, 10)
  const content = message.content
  const signature = createHash('sha256')
    .update(
      JSON.stringify([
        content,
        attachments.map((file) => [file.id, file.size, file.contentType, file.url.split('?')[0]])
      ])
    )
    .digest('hex')
  return { message, content, attachments, signature }
}
export type ModerationSnapshot = ReturnType<typeof moderationSnapshot>

function attachmentUrl(file: Attachment) {
  if (
    !Number.isSafeInteger(file.size) ||
    file.size <= 0 ||
    file.size > 20 * 1024 * 1024 ||
    file.url.length > 2048
  )
    return
  try {
    const url = new URL(file.url)
    if (
      url.protocol !== 'https:' ||
      !['cdn.discordapp.com', 'media.discordapp.net'].includes(url.hostname) ||
      url.port ||
      url.username ||
      url.password ||
      url.hash ||
      !/^\/attachments\/\d{17,20}\/\d{17,20}\/[^/]+$/.test(url.pathname)
    )
      return
    return url
  } catch {
    return
  }
}

async function readText(url: string, signal: AbortSignal, budget: number) {
  const response = await fetch(url, { signal, redirect: 'error' })
  if (!response.ok || !response.body) {
    await response.body?.cancel()
    throw new Error('Attachment download failed')
  }
  const reader = response.body.getReader()
  const chunks: Buffer[] = []
  let bytes = 0
  try {
    const length = response.headers.get('content-length')
    if (length && (!/^\d+$/.test(length) || Number(length) > budget))
      throw new Error('Attachment too large')
    for (;;) {
      const chunk = await reader.read()
      if (chunk.done) break
      bytes += chunk.value.byteLength
      if (bytes > budget) throw new Error('Attachment too large')
      chunks.push(Buffer.from(chunk.value))
    }
    const body = Buffer.concat(chunks) as Buffer
    return { text: new TextDecoder('utf-8', { fatal: true }).decode(body), bytes }
  } finally {
    await reader.cancel().catch(() => {})
    reader.releaseLock()
  }
}

export async function buildModerationInput(snapshot: ModerationSnapshot): Promise<{
  input: ModerationInput | undefined
  incomplete: boolean
}> {
  const parts: Array<
    { type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string } }
  > = []
  if (snapshot.content.trim()) parts.push({ type: 'text', text: snapshot.content.slice(0, 4000) })
  let imageBytes = 0
  let textBytes = 0
  let incomplete = false
  const signal = AbortSignal.timeout(10_000)
  for (const file of snapshot.attachments) {
    const url = attachmentUrl(file)
    const mime = file.contentType?.split(';')[0]?.trim().toLowerCase()
    const image =
      url &&
      (['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(mime ?? '') ||
        (!mime && /\.(?:png|jpe?g|webp|gif)$/i.test(url.pathname)))
    if (image && imageBytes + file.size <= 20 * 1024 * 1024) {
      imageBytes += file.size
      parts.push({ type: 'image_url', image_url: { url: url.href } })
      continue
    }
    const textFile =
      url &&
      (mime?.startsWith('text/') ||
        mime === 'application/json' ||
        (!mime && /\.(?:txt|md|csv|json|log)$/i.test(url.pathname)))
    if (textFile && textBytes + file.size <= 64 * 1024) {
      try {
        const result = await readText(url.href, signal, 64 * 1024 - textBytes)
        textBytes += result.bytes
        if (result.text.trim()) parts.push({ type: 'text', text: result.text })
        continue
      } catch {
        /* Still check the other supported inputs, without claiming complete coverage. */
      }
    }
    incomplete = true
  }
  if (!parts.length) return { input: undefined, incomplete }
  if (parts.length === 1 && parts[0]!.type === 'text') return { input: parts[0]!.text, incomplete }
  return { input: parts, incomplete }
}
