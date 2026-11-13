import type { Attachment, Message } from 'discord.js'

export interface RoleChatImage {
  url: string
  authorId: string
  messageId: string
}

const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp'])
const IMAGE_HOSTS = new Set(['cdn.discordapp.com', 'media.discordapp.net'])
const MAX_IMAGE_BYTES = 10 * 1024 * 1024

export function requestsRoleChatImage(prompt: string, hasImages: boolean): boolean {
  return (
    /(?:그려|그리기|그려줘|그려봐|그려줄|그려주|그려라|그리시오|draw\b|paint\b)/i.test(prompt) ||
    (/(?:사진|이미지|그림|짤|image|photo|picture)/i.test(prompt) &&
      /(?:생성|만들|만드|제작|편집|수정|바꿔|바꾸|합성|generate|create|make|edit|modify|change)/i.test(
        prompt
      )) ||
    (hasImages &&
      /(?:편집|수정|바꿔|바꾸|합성|지워|제거|보정|edit\b|modify\b|replace\b|remove\b)/i.test(
        prompt
      ))
  )
}

export function decodeRoleChatImage(result: string | null): Buffer {
  if (
    !result ||
    result.length > Math.ceil(MAX_IMAGE_BYTES / 3) * 4 ||
    result.length % 4 !== 0 ||
    !/^[A-Za-z0-9+/]*={0,2}$/.test(result)
  )
    throw new Error('Invalid generated image')
  const bytes = Buffer.from(result, 'base64')
  if (
    bytes.toString('base64') !== result ||
    bytes.length > MAX_IMAGE_BYTES ||
    !bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
  )
    throw new Error('Invalid generated PNG')
  return bytes
}

// Separate image-only budget: ordinary text requests retain their existing behavior.
export function createRoleChatImageBudget() {
  let pending = 0
  const recent: { scope: string; at: number }[] = []
  return (scope: string): (() => void) => {
    const now = Date.now()
    while (recent.length && recent[0]!.at <= now - 3_600_000) recent.shift()
    if (
      pending >= 2 ||
      recent.length >= 20 ||
      recent.some((item) => item.scope === scope && item.at > now - 60_000)
    )
      throw new Error('Image request budget exceeded')
    recent.push({ scope, at: now })
    pending++
    let released = false
    return () => {
      if (!released) pending--
      released = true
    }
  }
}

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
