import type { Attachment, Message } from 'discord.js'

export interface RoleChatImage {
  url: string
  authorId: string
  messageId: string
}

const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp'])
const IMAGE_HOSTS = new Set(['cdn.discordapp.com', 'media.discordapp.net'])
const MAX_IMAGE_BYTES = 10 * 1024 * 1024

export function roleChatImageUrl(
  file: Pick<Attachment, 'url' | 'size' | 'contentType'>
): string | undefined {
  if (
    !Number.isFinite(file.size) ||
    file.size <= 0 ||
    file.size > MAX_IMAGE_BYTES ||
    typeof file.url !== 'string' ||
    file.url.length > 2048
  )
    return
  const mime = file.contentType?.split(';')[0]!.trim().toLowerCase()
  if (mime && !IMAGE_TYPES.has(mime)) return
  try {
    const url = new URL(file.url)
    if (
      url.protocol !== 'https:' ||
      !IMAGE_HOSTS.has(url.hostname) ||
      url.port ||
      url.username ||
      url.password ||
      url.hash ||
      !/^\/attachments\/\d{17,20}\/\d{17,20}\/[^/]+$/.test(url.pathname) ||
      (!mime && !/\.(?:png|jpe?g|webp)$/i.test(url.pathname))
    )
      return
    return url.href
  } catch {
    return
  }
}

// Callers order messages by relevance: current request first, then newest history.
export function collectRoleChatImages(
  messages: readonly Message[],
  limit: number
): RoleChatImage[] {
  if (!Number.isInteger(limit) || limit < 1) return []
  const maxImages = Math.min(limit, 8)
  const images: RoleChatImage[] = []
  const seen = new Set<string>()
  for (const message of messages) {
    for (const file of [...message.attachments.values()].slice(0, 10)) {
      const url = roleChatImageUrl(file)
      if (!url || seen.has(url)) continue
      seen.add(url)
      images.push({ url, authorId: message.author.id, messageId: message.id })
      if (images.length >= maxImages) return images
    }
  }
  return images
}
