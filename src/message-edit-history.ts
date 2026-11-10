import {
  ChannelType,
  MessageFlags,
  PermissionFlagsBits,
  type Message,
  type PartialMessage,
  type MessageReaction,
  type PartialMessageReaction,
  type User,
  type PartialUser
} from 'discord.js'
import { z } from 'zod'
import { loadCommunitySettings } from './community-settings.js'
import { text } from './components.js'
import { formatMessageEditHistory, hasMessageEditDeletion } from './message-edit-diff.js'
import { consumeStoredRateLimit, getStoredValue, setStoredValue } from './helpers/kv-store.js'

const RETENTION = 30 * 24 * 60 * 60_000
const MAX_STATE = 4 * 1024 * 1024
const versionSchema = z.object({
  content: z.string().max(4000),
  at: z.number().int().nonnegative()
})
const recordSchema = z.object({
  authorId: z.string(),
  channelId: z.string(),
  updatedAt: z.number(),
  edited: z.boolean(),
  versions: z.array(versionSchema).min(1).max(10)
})
type Record = z.infer<typeof recordSchema>
const stateSchema = z.record(z.string(), recordSchema)
const key = (guildId: string) => `community:message-edit-history:${guildId}`
const viewers = new Map<string, number>()

async function withTimeout<T>(operation: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error('Message edit history operation timed out')),
          10_000
        )
        timer.unref()
      })
    ])
  } finally {
    clearTimeout(timer)
  }
}

function read(guildId: string) {
  const raw = getStoredValue(key(guildId))
  if (!raw || raw.length > MAX_STATE) return {}
  try {
    const parsed = stateSchema.parse(JSON.parse(raw))
    return Object.fromEntries(
      Object.entries(parsed).filter(
        ([, entry]) => entry.updatedAt <= Date.now() && entry.updatedAt > Date.now() - RETENTION
      )
    )
  } catch {
    return {}
  }
}

function save(guildId: string, id: string, entry?: Record) {
  const state = read(guildId)
  if (entry) state[id] = entry
  else delete state[id]
  write(guildId, state)
}

function write(guildId: string, state: { [id: string]: Record }) {
  const kept = Object.entries(state)
    .sort((a, b) => Number(b[1].edited) - Number(a[1].edited) || b[1].updatedAt - a[1].updatedAt)
    .slice(0, 200)
  let raw = JSON.stringify(Object.fromEntries(kept))
  while (raw.length > MAX_STATE) {
    kept.pop()
    raw = JSON.stringify(Object.fromEntries(kept))
  }
  setStoredValue(key(guildId), raw)
}

export function recordMessageOriginal(message: Message) {
  if (!message.guildId || message.author.bot || !loadCommunitySettings().messageEditHistory.enabled)
    return
  save(message.guildId, message.id, {
    authorId: message.author.id,
    channelId: message.channelId,
    updatedAt: Date.now(),
    edited: false,
    versions: [{ content: message.content.slice(0, 4000), at: message.createdTimestamp }]
  })
}

export async function recordMessageEdit(
  previous: Message | PartialMessage,
  incoming: Message | PartialMessage
) {
  if (!incoming.guildId || !loadCommunitySettings().messageEditHistory.enabled) return
  const previousContent = previous.content?.slice(0, 4000)
  const previousAt = previous.editedTimestamp ?? previous.createdTimestamp
  const message = incoming.partial ? await withTimeout(incoming.fetch()) : incoming
  if (!message.guildId || message.author.bot || !loadCommunitySettings().messageEditHistory.enabled)
    return
  const stored = read(message.guildId)[message.id]
  const content = message.content.slice(0, 4000)
  const before = stored?.versions.at(-1)?.content ?? previousContent
  // Embed, pin and reaction updates are not text edits.
  if (before === content || !message.editedTimestamp) return
  const hasDeletion = before !== undefined && hasMessageEditDeletion(before, content)
  const versions =
    stored?.versions ?? (before === undefined ? [] : [{ content: before, at: previousAt }])
  versions.push({ content, at: message.editedTimestamp })
  save(message.guildId, message.id, {
    authorId: message.author.id,
    channelId: message.channelId,
    updatedAt: Date.now(),
    edited: stored?.edited === true || hasDeletion,
    versions: versions.slice(-10)
  })
  if (hasDeletion) await withTimeout(message.react('✏️'))
}

export function deleteMessageEditHistory(message: Message | PartialMessage) {
  if (message.guildId) save(message.guildId, message.id)
}

export function deleteMessagesEditHistory(messages: Iterable<Message | PartialMessage>) {
  const guilds = new Map<string, { [id: string]: Record }>()
  for (const message of messages) {
    if (!message.guildId) continue
    let state = guilds.get(message.guildId)
    if (!state) {
      state = read(message.guildId)
      guilds.set(message.guildId, state)
    }
    delete state[message.id]
  }
  for (const [guildId, state] of guilds) write(guildId, state)
}

export async function showMessageEditHistory(
  reaction: MessageReaction | PartialMessageReaction,
  user: User | PartialUser
) {
  if (
    user.bot ||
    !['✏️', '✏'].includes(reaction.emoji.name ?? '') ||
    !loadCommunitySettings().messageEditHistory.enabled
  )
    return
  const partial = reaction.message
  if (!partial.guildId) return
  const entry = read(partial.guildId)[partial.id]
  if (!entry?.edited || entry.channelId !== partial.channelId) return
  const history = formatMessageEditHistory(entry.versions)
  if (!history) return
  // Bound network work and repeated replies across restarts as well as duplicate events.
  const viewerKey = `${partial.guildId}:${user.id}`
  if ((viewers.get(viewerKey) ?? 0) > Date.now()) return
  if (!consumeStoredRateLimit(`community:message-edit-views:${partial.guildId}`, 60, 60_000)) return
  viewers.delete(viewerKey)
  if (viewers.size >= 1000) viewers.delete(viewers.keys().next().value!)
  viewers.set(viewerKey, Date.now() + 10_000)
  const source = await withTimeout(partial.fetch(true))
  if (!source.guild || source.author.id !== entry.authorId) return
  const member = await withTimeout(source.guild.members.fetch({ user: user.id, force: true }))
  const channel = source.channel
  if (
    channel.isDMBased() ||
    !channel
      .permissionsFor(member)
      ?.has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ReadMessageHistory])
  )
    return
  if (
    channel.type === ChannelType.PrivateThread &&
    !member.permissions.has(PermissionFlagsBits.ManageThreads) &&
    !(await withTimeout(channel.members.fetch(user.id)).catch(() => null))
  )
    return
  if (!loadCommunitySettings().messageEditHistory.enabled || !read(partial.guildId)[partial.id])
    return
  await withTimeout(
    source.reply({
      flags: MessageFlags.IsComponentsV2,
      components: [text(history)],
      allowedMentions: { parse: [], repliedUser: false }
    })
  )
}
