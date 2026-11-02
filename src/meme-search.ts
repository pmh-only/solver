import { AttachmentBuilder, PermissionFlagsBits, type Message } from 'discord.js'
import { z } from 'zod'
import { loadCommunitySettings } from './community-settings.js'
import { downloadUrl } from './commands/down-runtime.js'

const API = 'https://meme.lth.so/api/'
const WEBHOOK_NAME = 'solver-meme'
const resultsSchema = z.object({
  items: z.array(z.object({ id: z.string().uuid(), content_type: z.literal('image') })).max(24)
})
const mediaSchema = z.object({ original: z.object({ url: z.string().url().max(4096) }) })

async function apiJson(path: string): Promise<unknown> {
  const response = await fetch(new URL(path, API), {
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

export async function findMemeImage(query: string) {
  const params = new URLSearchParams({ q: query, content_type: 'image', limit: '1' })
  const result = resultsSchema.parse(await apiJson(`memes?${params}`)).items[0]
  if (!result) return null
  const media = mediaSchema.parse(await apiJson(`memes/${result.id}/media`))
  const url = new URL(media.original.url)
  if (
    url.protocol !== 'https:' ||
    url.hostname !== 's3.lth.so' ||
    url.username ||
    url.password ||
    url.port
  )
    throw new Error('Unexpected meme media host')
  // Reuse bounded downloads with public-address and redirect validation.
  const file = await downloadUrl(url.href)
  const mime = file.contentType.split(';')[0].toLowerCase()
  const suffix = {
    'image/png': 'png',
    'image/jpeg': 'jpg',
    'image/webp': 'webp',
    'image/gif': 'gif'
  }[mime]
  if (!suffix || !file.data.length) throw new Error('Unsupported meme image')
  return new AttachmentBuilder(file.data, { name: `meme.${suffix}` })
}

export function createMemeSearchHandler(findImage = findMemeImage) {
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
    if (!bot || !parent.permissionsFor(bot)?.has(PermissionFlagsBits.ManageWebhooks)) return true
    if (sent.has(message.id) || activeChannels.has(parent.id) || activeChannels.size >= 2)
      return true
    activeChannels.add(parent.id)
    try {
      const image = await findImage(query)
      if (!image || loadCommunitySettings().memeSearch?.roleId !== settings.roleId) return true
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
        files: [image],
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
