import { PermissionFlagsBits, type Message } from 'discord.js'
import { z } from 'zod'
import { loadCommunitySettings } from './community-settings.js'
import { playMemeAudio } from './meme-voice.js'

export interface MemeContent {
  type: 'image' | 'audio' | 'text'
  content: string
}

const API = 'https://meme.lth.so/api/'
const WEBHOOK_NAME = 'solver-meme'
const resultsSchema = z.object({
  items: z
    .array(
      z.discriminatedUnion('content_type', [
        z.object({ id: z.string().uuid(), content_type: z.enum(['image', 'audio']) }),
        z.object({
          id: z.string().uuid(),
          content_type: z.literal('text'),
          body_text: z
            .string()
            .max(10_000)
            .refine((value) => value.trim().length > 0)
        })
      ])
    )
    .max(24)
})
const mediaSchema = z.object({ original: z.object({ url: z.string().url().max(2000) }) })
const giphySchema = z.object({
  data: z.array(z.object({ images: mediaSchema })).max(1)
})

async function apiJson(url: URL): Promise<unknown> {
  const response = await fetch(url, {
    signal: AbortSignal.timeout(10_000),
    redirect: 'error'
  })
  if (!response.ok) throw new Error('Meme search failed')
  const reader = response.body?.getReader()
  if (!reader) throw new Error('Empty meme response')
  const chunks: Buffer[] = []
  let size = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      size += value.byteLength
      if (size > 256 * 1024) throw new Error('Oversized meme response')
      chunks.push(Buffer.from(value))
    }
  } finally {
    await reader.cancel()
  }
  return JSON.parse((Buffer.concat(chunks) as Buffer).toString('utf8'))
}

async function findGiphyContent(query: string): Promise<MemeContent | null> {
  const apiKey = loadCommunitySettings().memeSearch?.giphyApiKey
  if (!apiKey) return null
  const url = new URL('https://api.giphy.com/v1/gifs/search')
  url.search = new URLSearchParams({
    api_key: apiKey,
    q: query,
    limit: '1',
    rating: 'pg-13',
    lang: 'ko',
    fields: 'images.original.url'
  }).toString()
  const result = giphySchema.parse(await apiJson(url)).data[0]
  if (!result) return null
  const media = new URL(result.images.original.url)
  if (
    media.protocol !== 'https:' ||
    !/^media\d*\.giphy\.com$/.test(media.hostname) ||
    media.username ||
    media.password ||
    media.port
  )
    throw new Error('Unexpected GIPHY media host')
  return { type: 'image', content: result.images.original.url }
}

export async function findMemeContent(query: string): Promise<MemeContent | null> {
  const params = new URLSearchParams({ q: query, limit: '1' })
  const result = resultsSchema.parse(await apiJson(new URL(`memes?${params}`, API))).items[0]
  if (!result) return findGiphyContent(query)
  if (result.content_type === 'text') {
    return {
      type: 'text',
      content:
        result.body_text.length > 2000 ? `${result.body_text.slice(0, 1999)}…` : result.body_text
    }
  }
  const media = mediaSchema.parse(await apiJson(new URL(`memes/${result.id}/media`, API)))
  const url = new URL(media.original.url)
  if (
    url.protocol !== 'https:' ||
    url.hostname !== 's3.lth.so' ||
    url.username ||
    url.password ||
    url.port
  )
    throw new Error('Unexpected meme media host')
  return { type: result.content_type, content: media.original.url }
}

export function createMemeSearchHandler(findContent = findMemeContent, playAudio = playMemeAudio) {
  const activeChannels = new Set<string>()
  const sent = new Set<string>()
  return async (message: Message): Promise<boolean> => {
    if (!message.guildId || message.author.bot || message.webhookId || message.system) return false
    const settings = loadCommunitySettings().memeSearch
    if (!settings) return false
    const match = new RegExp(`^<@&${settings.roleId}>(?:\\s+([\\s\\S]*))?$`).exec(
      message.content.trim()
    )
    if (!match) return false
    const query = match[1]?.trim()
    // Never destroy attachments or turn a failed lookup into another chat request.
    if (!query || query.length > 200 || message.attachments.size || !message.deletable) return true
    const channel = message.channel
    const parent = channel.isThread() ? channel.parent : channel
    if (!parent || !('fetchWebhooks' in parent) || !('createWebhook' in parent)) return true
    const bot = message.client.user
    if (!bot) return true
    const canWebhook = parent.permissionsFor(bot)?.has(PermissionFlagsBits.ManageWebhooks)
    if (!canWebhook && !message.member?.voice?.channelId) return true
    if (sent.has(message.id) || activeChannels.has(parent.id) || activeChannels.size >= 2)
      return true
    activeChannels.add(parent.id)
    try {
      const content = await findContent(query)
      if (!content || loadCommunitySettings().memeSearch?.roleId !== settings.roleId) return true
      if (content.type === 'audio' && (await playAudio(message, content.content))) {
        sent.add(message.id)
        if (sent.size > 500) sent.delete(sent.values().next().value!)
        await message.delete()
        return true
      }
      if (!canWebhook) return true
      const hooks = await parent.fetchWebhooks()
      const hook =
        hooks.find(
          (item) => item.owner?.id === bot.id && item.name === WEBHOOK_NAME && Boolean(item.token)
        ) ?? (await parent.createWebhook({ name: WEBHOOK_NAME }))
      await hook.send({
        username: (
          message.member?.displayName ??
          message.author.globalName ??
          message.author.username
        ).slice(0, 80),
        avatarURL: message.member?.displayAvatarURL() ?? message.author.displayAvatarURL(),
        content: content.content,
        ...(channel.isThread() ? { threadId: channel.id } : {}),
        allowedMentions: { parse: [], repliedUser: false }
      })
      sent.add(message.id)
      if (sent.size > 500) sent.delete(sent.values().next().value!)
      await message.delete()
    } catch {
      // Signed media URLs and webhook tokens must never be logged.
      console.error('meme search failed; original message retained')
    } finally {
      activeChannels.delete(parent.id)
    }
    return true
  }
}
