import { createHash, randomUUID } from 'node:crypto'
import { EmbedBuilder, type Message, type PartialMessage } from 'discord.js'
import { z } from 'zod'
import { loadCommunitySettings } from './community-settings.js'
import { getStoredValue, setStoredValue } from './helpers/kv-store.js'

const THRESHOLD = 3
const TIMEOUT_MS = 10_000
const RETENTION_MS = 30 * 24 * 60 * 60_000
const MAX_RECORDS = 1000
const NO_MENTIONS = { parse: [] as const, repliedUser: false }
const discordId = z.string().regex(/^\d{17,20}$/)
const recordSchema = z
  .object({
    channelId: discordId,
    forwardedMessageId: discordId,
    embedMessageId: discordId.nullable(),
    signature: z.string().max(64),
    updatedAt: z.number().int().positive(),
    deleted: z.boolean().optional(),
    generation: z.string().uuid().optional()
  })
  .strict()
type ForwardRecord = z.infer<typeof recordSchema>
const recordsSchema = z
  .record(z.string().regex(/^\d{17,20}:\d{17,20}$/), recordSchema)
  .refine((records) => Object.keys(records).length <= MAX_RECORDS)

function readRecords(guildId: string): Record<string, ForwardRecord> {
  const raw = getStoredValue(`community:reaction-forward:${guildId}`)
  if (!raw) return Object.create(null)
  if (raw.length > 1024 * 1024) throw new Error('Reaction-forward state is oversized')
  const records = recordsSchema.parse(JSON.parse(raw))
  const now = Date.now()
  return Object.fromEntries(
    Object.entries(records).filter(
      ([, record]) => record.updatedAt <= now && record.updatedAt > now - RETENTION_MS
    )
  )
}

function saveRecord(guildId: string, key: string, record: ForwardRecord) {
  // Reload synchronously after network work so concurrent messages cannot lose each other's records.
  const records = readRecords(guildId)
  records[key] = record
  const kept = Object.entries(records)
    .sort((a, b) => b[1].updatedAt - a[1].updatedAt)
    .slice(0, MAX_RECORDS)
  setStoredValue(`community:reaction-forward:${guildId}`, JSON.stringify(Object.fromEntries(kept)))
}

function hash(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

async function withTimeout<T>(operation: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('Reaction forwarding timed out')), TIMEOUT_MS)
        timer.unref()
      })
    ])
  } finally {
    clearTimeout(timer)
  }
}

function reactionSummary(message: Message) {
  const reactions = [...message.reactions.cache.values()].filter(
    (reaction) => Number.isSafeInteger(reaction.count) && reaction.count > 0
  )
  const total = reactions.reduce((sum, reaction) => sum + reaction.count, 0)
  const embed = new EmbedBuilder()
    .setAuthor({
      name: (message.member?.displayName ?? message.author.username).slice(0, 256),
      iconURL: message.author.displayAvatarURL(),
      url: `https://discord.com/users/${message.author.id}`
    })
    .setTitle('원본 메시지')
    .setURL(message.url)
    .setDescription(
      reactions
        .map((reaction) => `${reaction.emoji.toString()} **${reaction.count}**`)
        .join('\n')
        .slice(0, 4000) || '반응 없음'
    )
    .setFooter({ text: `총 ${total}개 반응` })
  return { total, embed, signature: hash(JSON.stringify(embed.toJSON())) }
}

async function syncReactionForward(partial: Message | PartialMessage) {
  if (!partial.guildId) return
  const settings = loadCommunitySettings().reactionForward
  if (!settings || partial.channelId === settings.channelId) return
  // Always fetch fresh aggregate counts, including for old/uncached messages and removals.
  const source = await withTimeout(partial.fetch(true))
  if (loadCommunitySettings().reactionForward?.channelId !== settings.channelId) return
  if (
    source.guildId !== partial.guildId ||
    source.channelId !== partial.channelId ||
    source.id !== partial.id
  )
    return
  const { total, embed, signature } = reactionSummary(source)
  const key = `${source.channelId}:${source.id}`
  let state: ForwardRecord | undefined = readRecords(partial.guildId)[key]
  if (state?.channelId !== settings.channelId) state = undefined
  const generation = state?.generation
  if (state?.deleted) state = undefined
  if ((total < THRESHOLD && !state) || (total === THRESHOLD && state?.embedMessageId)) return
  if (state?.embedMessageId && state.signature === signature) return

  const channel = await withTimeout(source.client.channels.fetch(settings.channelId))
  if (!channel?.isSendable() || !('guildId' in channel) || channel.guildId !== source.guildId) {
    throw new Error('Reaction-forward destination must be a sendable channel in the same guild')
  }
  if (loadCommunitySettings().reactionForward?.channelId !== settings.channelId) return
  if (total < THRESHOLD && state) {
    const ids = [state.forwardedMessageId, state.embedMessageId].filter((id): id is string =>
      Boolean(id)
    )
    const results = await Promise.allSettled(
      ids.map(async (id) => {
        try {
          await withTimeout(channel.messages.delete(id))
        } catch (error) {
          if (!error || typeof error !== 'object' || !('code' in error) || error.code !== 10008)
            throw error
        }
      })
    )
    const failure = results.find((result) => result.status === 'rejected')
    if (failure?.status === 'rejected') throw failure.reason
    // Keep a bounded tombstone with a fresh nonce generation: immediately crossing
    // back to 3 must create new posts, not deduplicate against the deleted pair.
    saveRecord(partial.guildId, key, {
      ...state,
      embedMessageId: null,
      signature: '',
      deleted: true,
      generation: randomUUID(),
      updatedAt: Date.now()
    })
    return
  }
  const nonce = (kind: string) =>
    hash(
      `${kind}:${source.guildId}:${source.id}:${channel.id}${generation ? ':' + generation : ''}`
    ).slice(0, 24)
  if (!state) {
    // Native Discord forwarding: creates a message snapshot instead of copying text/files.
    const forwarded = await withTimeout(
      channel.send({
        forward: { message: source.id, channel: source.channelId, guild: source.guildId! },
        nonce: nonce('forward'),
        enforceNonce: true,
        allowedMentions: NO_MENTIONS
      })
    )
    state = {
      channelId: channel.id,
      forwardedMessageId: forwarded.id,
      embedMessageId: null,
      signature: '',
      updatedAt: Date.now(),
      ...(generation ? { generation } : {})
    }
    // Persist before sending the separate author/count embed; retries must not forward again.
    saveRecord(partial.guildId, key, state)
  }
  if (!state.embedMessageId) {
    const summary = await withTimeout(
      channel.send({
        embeds: [embed],
        nonce: nonce('summary'),
        enforceNonce: true,
        allowedMentions: NO_MENTIONS
      })
    )
    state.embedMessageId = summary.id
  } else {
    await withTimeout(
      channel.messages.edit(state.embedMessageId, { embeds: [embed], allowedMentions: NO_MENTIONS })
    )
  }
  state.signature = signature
  state.updatedAt = Date.now()
  saveRecord(partial.guildId, key, state)
}

export function createReactionForwardHandler() {
  const jobs = new Map<string, { dirty: boolean; promise: Promise<void> }>()
  return (message: Message | PartialMessage): Promise<void> => {
    if (!message.guildId) return Promise.resolve()
    const key = `${message.guildId}:${message.channelId}:${message.id}`
    const existing = jobs.get(key)
    if (existing) {
      existing.dirty = true
      return existing.promise
    }
    if (jobs.size >= 250) return Promise.resolve()
    const job = { dirty: true, promise: Promise.resolve() }
    jobs.set(key, job)
    job.promise = (async () => {
      try {
        do {
          job.dirty = false
          await syncReactionForward(message)
        } while (job.dirty)
      } finally {
        jobs.delete(key)
      }
    })()
    return job.promise
  }
}
