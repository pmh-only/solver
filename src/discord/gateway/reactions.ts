import { createHash, randomUUID } from 'node:crypto'
import {
  EmbedBuilder,
  ReactionType,
  type Message,
  type PartialMessage,
  type Webhook
} from 'discord.js'
import { z } from 'zod'
import { loadCommunitySettings } from '../../features/community/settings.js'
import { getStoredValue, setStoredValue } from '../../shared/storage/kv-store.js'

const THRESHOLD = 3
const TIMEOUT_MS = 10_000
const RETENTION_MS = 30 * 24 * 60 * 60_000
const MAX_RECORDS = 1000
const WEBHOOK_NAME = 'solver reaction forward'
const webhookJobs = new Map<string, Promise<Webhook>>()
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

async function reactionSummary(message: Message) {
  const reactions = [...message.reactions.cache.values()].filter(
    (reaction) => Number.isSafeInteger(reaction.count) && reaction.count > 0
  )
  const people = new Set<string>()
  const descriptions: string[] = []
  let requests = 0
  const deadline = Date.now() + TIMEOUT_MS
  for (const reaction of reactions) {
    const reactors = new Set<string>()
    const types = [ReactionType.Normal]
    if (reaction.countDetails.burst > 0) types.push(ReactionType.Super)
    for (const type of types) {
      let after: string | undefined
      for (;;) {
        // Never decide using an incomplete list or cached reaction users.
        if (++requests > 100 || Date.now() >= deadline) {
          throw new Error('Reaction user enumeration exceeded its limit')
        }
        const users = await withTimeout(reaction.users.fetch({ type, limit: 100, after }))
        for (const user of users.values()) {
          if (!user.bot) {
            reactors.add(user.id)
            people.add(user.id)
          }
        }
        if (users.size < 100) break
        const cursor = [...users.keys()].reduce((max, id) => (BigInt(id) > BigInt(max) ? id : max))
        if (after && BigInt(cursor) <= BigInt(after))
          throw new Error('Reaction user pagination stalled')
        after = cursor
      }
    }
    if (reactors.size) descriptions.push(`${reaction.emoji.toString()} **${reactors.size}**`)
  }
  const total = people.size
  const embed = new EmbedBuilder()
    .setAuthor({
      name: (message.member?.displayName ?? message.author.username).slice(0, 256),
      iconURL: message.author.displayAvatarURL(),
      url: `https://discord.com/users/${message.author.id}`
    })
    .setDescription(descriptions.join(' · ').slice(0, 4000) || '반응 없음')
  return { total, embed, signature: hash(JSON.stringify({ total, embed: embed.toJSON() })) }
}

async function syncReactionForward(partial: Message | PartialMessage) {
  if (!partial.guildId) return
  const settings = loadCommunitySettings().reactionForward
  if (!settings || partial.channelId === settings.channelId) return
  // Always fetch fresh reactions and users, including for old/uncached messages and removals.
  const source = await withTimeout(partial.fetch(true))
  if (loadCommunitySettings().reactionForward?.channelId !== settings.channelId) return
  if (
    source.guildId !== partial.guildId ||
    source.channelId !== partial.channelId ||
    source.id !== partial.id
  )
    return
  const { total, embed, signature } = await reactionSummary(source)
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
  const webhookChannel = channel.isThread() ? channel.parent : channel
  if (
    !webhookChannel ||
    !('createWebhook' in webhookChannel) ||
    !('fetchWebhooks' in webhookChannel)
  ) {
    throw new Error('Reaction-forward destination must support webhooks')
  }
  const botId = source.client.user?.id
  if (!botId) throw new Error('Reaction forwarding requires a ready Discord client')
  // Discover the bot-owned webhook after restarts without persisting its token.
  // Serialize discovery/creation so different source messages share one webhook.
  let webhookJob = webhookJobs.get(webhookChannel.id)
  if (!webhookJob) {
    if (webhookJobs.size >= 250) throw new Error('Too many reaction-forward webhook jobs')
    webhookJob = (async () => {
      const webhooks = await withTimeout(webhookChannel.fetchWebhooks())
      const existing = webhooks.find(
        (hook) => hook.isIncoming() && hook.owner?.id === botId && hook.name === WEBHOOK_NAME
      )
      return existing ?? (await withTimeout(webhookChannel.createWebhook({ name: WEBHOOK_NAME })))
    })()
    webhookJobs.set(webhookChannel.id, webhookJob)
  }
  let webhook: Webhook
  try {
    webhook = await webhookJob
  } finally {
    if (webhookJobs.get(webhookChannel.id) === webhookJob) webhookJobs.delete(webhookChannel.id)
  }
  if (!webhook.isIncoming()) throw new Error('Reaction-forward webhook must be incoming')
  if (loadCommunitySettings().reactionForward?.channelId !== settings.channelId) return
  const payload = {
    embeds: [embed],
    allowedMentions: NO_MENTIONS,
    ...(channel.isThread() ? { threadId: channel.id } : {})
  }
  if (state.embedMessageId) {
    try {
      await withTimeout(webhook.editMessage(state.embedMessageId, payload))
    } catch (error) {
      // Migrate pre-webhook summaries, or recover a manually removed summary.
      if (
        !error ||
        typeof error !== 'object' ||
        !('code' in error) ||
        ![10008, 50005].includes(Number(error.code))
      )
        throw error
      try {
        await withTimeout(channel.messages.delete(state.embedMessageId))
      } catch (deletionError) {
        if (
          !deletionError ||
          typeof deletionError !== 'object' ||
          !('code' in deletionError) ||
          deletionError.code !== 10008
        )
          throw deletionError
      }
      state.embedMessageId = null
      saveRecord(partial.guildId, key, state)
    }
  }
  if (!state.embedMessageId) {
    const summary = await withTimeout(webhook.send(payload))
    state.embedMessageId = summary.id
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
