import { createHash, randomUUID } from 'node:crypto'
import { z } from 'zod'
import { isAdminUser } from './authorization.js'
import {
  COMMUNITY_SETTINGS_KEY,
  loadCommunitySettings,
  manageCommunitySettings
} from './community-settings.js'
import {
  deleteStoredValue,
  getStoredValue,
  listStoredKeys,
  setStoredValue
} from './helpers/kv-store.js'
import { clearRuntimeIssue, reportRuntimeIssue } from './runtime-health.js'
import { DiscordArchiveOutbox } from './helpers/discord-archive-outbox.js'

const WATCH_PREFIX = 'community:discord-archive:watch:'
const MAX_EVENTS = 1000
const MAX_BYTES = 16 * 1024 * 1024
const RETENTION_MS = 7 * 24 * 60 * 60_000
const snowflake = z.string().regex(/^\d{17,20}$/)
const eventTypes = [
  'MESSAGE_CREATE',
  'MESSAGE_UPDATE',
  'MESSAGE_DELETE',
  'MESSAGE_DELETE_BULK',
  'MESSAGE_REACTION_ADD',
  'MESSAGE_REACTION_REMOVE',
  'MESSAGE_REACTION_REMOVE_ALL',
  'MESSAGE_REACTION_REMOVE_EMOJI',
  'MESSAGE_POLL_VOTE_ADD',
  'MESSAGE_POLL_VOTE_REMOVE'
] as const
const watchSchema = z.object({
  channelId: snowflake,
  guildId: snowflake,
  userId: snowflake,
  enabled: z.boolean(),
  lastEventAt: z.number().nullable(),
  issue: z.string().max(400).nullable(),
  needsRefresh: z.boolean()
})
const eventSchema = z.object({
  eventId: z.string().regex(/^[a-f0-9]{64}$/),
  channelId: snowflake,
  guildId: snowflake,
  type: z.enum(eventTypes),
  sequence: z.number().int().nonnegative().nullable(),
  receivedAt: z.number().int().nonnegative(),
  order: z.number().int().nonnegative(),
  data: z.record(z.string(), z.unknown())
})
export type ArchiveWatch = z.infer<typeof watchSchema>
export type ArchiveGatewayEvent = z.infer<typeof eventSchema>
type ApplyBatch = (watch: ArchiveWatch, events: ArchiveGatewayEvent[]) => Promise<boolean>

export function archiveJson(value: unknown): string {
  const json = JSON.stringify(value, (key, item: unknown) =>
    /^(?:token|access_token|authorization|client_secret)$/i.test(key) ? undefined : item
  )
  if (!json || Buffer.byteLength(json) > 1024 * 1024)
    throw new Error('Message metadata exceeds the 1 MiB record limit')
  return json
}

export class DiscordArchiveLiveQueue {
  private readonly watches = new Map<string, ArchiveWatch>()
  private readonly pending = new Map<string, { event: ArchiveGatewayEvent; bytes: number }>()
  private readonly retryAt = new Map<string, number>()
  private readonly bootId = randomUUID()
  private bytes = 0
  private order = 0
  private timer?: ReturnType<typeof setTimeout>
  private flushing?: Promise<number>
  private closed = false
  private readonly outbox: DiscordArchiveOutbox

  constructor(
    private readonly apply: ApplyBatch,
    outboxPath: string,
    private readonly automatic = true
  ) {
    this.outbox = new DiscordArchiveOutbox(outboxPath)
    const keys = listStoredKeys()
    for (const key of keys.filter((item) => item.startsWith(WATCH_PREFIX)).slice(0, 500)) {
      try {
        const watch = watchSchema.parse(JSON.parse(getStoredValue(key)!))
        if (key !== WATCH_PREFIX + watch.channelId) throw new Error('Invalid watch key')
        this.watches.set(watch.channelId, watch)
      } catch {
        reportRuntimeIssue(
          'discord_archive_realtime',
          new Error('Invalid persisted archive watch; configure the channel again through /a')
        )
      }
    }
    // Preserve an existing explicitly enrolled single channel when upgrading old settings.
    // An explicit channelId:null is not migrated; multiple watches require an administrator's choice.
    try {
      const raw = JSON.parse(getStoredValue(COMMUNITY_SETTINGS_KEY) ?? '{}') as {
        discordArchive?: Record<string, unknown>
      }
      const active = [...this.watches.values()].filter((watch) => watch.enabled)
      if (
        raw.discordArchive &&
        !Object.hasOwn(raw.discordArchive, 'channelId') &&
        active.length === 1
      ) {
        const settings = loadCommunitySettings().discordArchive
        manageCommunitySettings({
          action: 'update',
          settings: { discordArchive: { ...settings, channelId: active[0]!.channelId } }
        })
      }
    } catch {
      /* Corrupt settings remain disabled by all ingestion paths. */
    }
    const restored: { event: ArchiveGatewayEvent; bytes: number }[] = []
    for (const item of this.outbox.list()) {
      try {
        const raw = item.payload
        const event = eventSchema.parse(JSON.parse(raw))
        const bytes = Buffer.byteLength(raw)
        if (
          item.id !== event.eventId ||
          item.channel_id !== event.channelId ||
          this.watches.get(event.channelId)?.guildId !== event.guildId ||
          Date.now() - event.receivedAt >= RETENTION_MS ||
          event.receivedAt > Date.now() + 60_000 ||
          restored.length >= MAX_EVENTS ||
          this.bytes + bytes > MAX_BYTES
        ) {
          this.issue(
            event.channelId,
            'Realtime events expired or exceeded the durable queue limit; refresh history through /a.',
            true
          )
          this.outbox.delete(item.id)
          continue
        }
        restored.push({ event, bytes })
        this.bytes += bytes
        this.order = Math.max(this.order, event.order)
      } catch {
        this.outbox.delete(item.id)
        this.issue(
          item.channel_id,
          'Corrupt realtime event discarded; refresh history through /a.',
          true
        )
      }
    }
    for (const item of restored.sort((a, b) => a.event.order - b.event.order))
      this.pending.set(item.event.eventId, item)
  }

  watch(channelId: string, guildId: string, userId: string) {
    for (const watch of this.watches.values()) {
      if (watch.channelId !== channelId && watch.enabled)
        this.saveWatch({ ...watch, enabled: false })
    }
    const previous = this.watches.get(channelId)
    if (!previous && this.watches.size >= 500)
      throw new Error('Realtime archive channel limit reached')
    this.saveWatch({
      channelId,
      guildId,
      userId,
      enabled: true,
      lastEventAt: previous?.lastEventAt ?? null,
      issue: null,
      needsRefresh: previous?.needsRefresh ?? false
    })
    this.retryAt.delete(channelId)
    this.schedule()
  }

  unwatch(channelId: string) {
    const watch = this.watches.get(channelId)
    if (watch) this.saveWatch({ ...watch, enabled: false })
  }

  remove(channelId: string) {
    this.watches.delete(channelId)
    deleteStoredValue(WATCH_PREFIX + channelId)
    this.retryAt.delete(channelId)
    for (const [id, item] of this.pending)
      if (item.event.channelId === channelId) this.acknowledge(id)
  }

  stats(channelId: string) {
    const watch = this.watches.get(channelId)
    let enabled = false
    try {
      const settings = loadCommunitySettings().discordArchive
      enabled = Boolean(watch?.enabled && settings.enabled && settings.channelId === channelId)
    } catch {
      /* Fail closed on corrupt settings. */
    }
    return {
      realtime_enabled: enabled,
      queued_events: [...this.pending.values()].filter((item) => item.event.channelId === channelId)
        .length,
      last_gateway_event_at: watch?.lastEventAt ?? null,
      realtime_issue: watch?.issue ?? null,
      needs_history_refresh: watch?.needsRefresh ?? false
    }
  }

  ingest(packet: unknown): boolean {
    if (
      this.closed ||
      !packet ||
      typeof packet !== 'object' ||
      !('t' in packet) ||
      !('d' in packet)
    )
      return false
    const type = z.enum(eventTypes).safeParse(packet.t)
    const data = packet.d
    if (
      !type.success ||
      !data ||
      typeof data !== 'object' ||
      Array.isArray(data) ||
      !('channel_id' in data) ||
      typeof data.channel_id !== 'string'
    )
      return false
    const watch = this.watches.get(data.channel_id)
    if (!watch?.enabled) return false
    if (!isAdminUser(watch.userId)) {
      this.issue(
        watch.channelId,
        'Realtime archive owner is no longer an administrator; authorize tracking again through /a.',
        true
      )
      return false
    }
    try {
      const settings = loadCommunitySettings().discordArchive
      if (!settings.enabled || settings.channelId !== watch.channelId) return false
      const source = data as Record<string, unknown>
      const ids =
        type.data === 'MESSAGE_DELETE_BULK' ? source.ids : [source.id ?? source.message_id]
      if (
        source.guild_id !== watch.guildId ||
        !Array.isArray(ids) ||
        ids.length === 0 ||
        ids.length > 100 ||
        ids.some((id) => !snowflake.safeParse(id).success)
      )
        throw new Error('Invalid gateway payload')
      if (
        type.data === 'MESSAGE_CREATE' &&
        (!source.author ||
          typeof source.author !== 'object' ||
          !('id' in source.author) ||
          !snowflake.safeParse(source.author.id).success ||
          typeof source.timestamp !== 'string')
      )
        throw new Error('Invalid create payload')
      const json = archiveJson(source)
      const sequence =
        's' in packet &&
        typeof packet.s === 'number' &&
        Number.isSafeInteger(packet.s) &&
        packet.s >= 0
          ? packet.s
          : null
      const eventId = createHash('sha256')
        .update(`${this.bootId}:${sequence}:${type.data}:${json}`)
        .digest('hex')
      if (this.pending.has(eventId)) return true
      this.order = Math.max(this.order + 1, Date.now() * 1000)
      const event: ArchiveGatewayEvent = {
        eventId,
        type: type.data,
        channelId: watch.channelId,
        guildId: watch.guildId,
        sequence,
        receivedAt: Date.now(),
        order: this.order,
        data: JSON.parse(json) as Record<string, unknown>
      }
      const serialized = JSON.stringify(event)
      const bytes = Buffer.byteLength(serialized)
      if (this.pending.size >= MAX_EVENTS || this.bytes + bytes > MAX_BYTES)
        throw new Error('Queue full')
      this.outbox.put(eventId, watch.channelId, serialized)
      this.pending.set(eventId, { event, bytes })
      this.bytes += bytes
      this.schedule()
      return true
    } catch {
      this.issue(
        watch.channelId,
        'Realtime event could not be queued (invalid metadata, storage failure or backlog limit). Refresh history through /a.',
        true
      )
      return false
    }
  }

  start(retry = false) {
    if (retry) this.retryAt.clear()
    clearTimeout(this.timer)
    this.timer = undefined
    this.schedule(0)
  }

  async flush(channelId?: string, apply = this.apply): Promise<number> {
    if (this.flushing) return this.flushing
    if (this.closed || !this.pending.size) return Promise.resolve(0)
    let enabled = false
    let configuredChannel: string | null = null
    try {
      const settings = loadCommunitySettings().discordArchive
      enabled = settings.enabled
      configuredChannel = settings.channelId
    } catch {
      /* Fail closed. */
    }
    if (!enabled) {
      this.schedule(30_000)
      return Promise.resolve(0)
    }
    const first = [...this.pending.values()].find(
      (item) =>
        item.event.channelId === configuredChannel &&
        (!channelId || item.event.channelId === channelId) &&
        (this.retryAt.get(item.event.channelId) ?? 0) <= Date.now()
    )
    if (!first) {
      this.schedule(30_000)
      return Promise.resolve(0)
    }
    const target = first.event.channelId
    const watch = this.watches.get(target)
    if (!watch) {
      this.remove(target)
      return Promise.resolve(0)
    }
    const batch: ArchiveGatewayEvent[] = []
    let bytes = 0
    let operations = 0
    for (const item of this.pending.values()) {
      if (item.event.channelId !== target) continue
      const cost = Array.isArray(item.event.data.ids)
        ? item.event.data.ids.length
        : item.event.type === 'MESSAGE_UPDATE'
          ? 100
          : 1
      if (batch.length >= 100 || bytes + item.bytes > 4 * 1024 * 1024 || operations + cost > 500)
        break
      if (Date.now() - item.event.receivedAt >= RETENTION_MS) {
        this.acknowledge(item.event.eventId)
        this.issue(target, 'Realtime events expired; refresh history through /a.', true)
        continue
      }
      batch.push(item.event)
      bytes += item.bytes
      operations += cost
    }
    if (!batch.length) {
      this.schedule()
      return 0
    }
    this.flushing = (async () => {
      try {
        if (!batch.length || !(await apply(watch, batch))) return 0
        for (const event of batch) this.acknowledge(event.eventId)
        const current = this.watches.get(target)
        if (current)
          this.saveWatch({ ...current, lastEventAt: batch.at(-1)!.receivedAt, issue: null })
        this.retryAt.delete(target)
        if (![...this.watches.values()].some((item) => item.issue))
          clearRuntimeIssue('discord_archive_realtime')
        return batch.length
      } catch {
        this.retryAt.set(target, Date.now() + 30_000)
        this.issue(
          target,
          'Realtime writes are paused; queued events are retained. Check channel permissions, storage quota and database availability through /a.',
          false
        )
        return 0
      } finally {
        this.flushing = undefined
        this.schedule()
      }
    })()
    return this.flushing
  }

  async close() {
    if (this.closed) return this.flushing
    this.closed = true
    clearTimeout(this.timer)
    await this.flushing
    this.outbox.close()
  }

  private schedule(delay = 250) {
    if (!this.automatic || this.closed || this.timer || !this.pending.size) return
    this.timer = setTimeout(() => {
      this.timer = undefined
      void this.flush().catch(() =>
        reportRuntimeIssue(
          'discord_archive_realtime',
          new Error('Realtime archive flush failed; queued events are retained')
        )
      )
    }, delay)
    this.timer.unref()
  }

  private acknowledge(id: string) {
    const item = this.pending.get(id)
    this.outbox.delete(id)
    if (item) {
      this.bytes -= item.bytes
      this.pending.delete(id)
    }
  }

  private saveWatch(watch: ArchiveWatch) {
    setStoredValue(WATCH_PREFIX + watch.channelId, JSON.stringify(watch))
    this.watches.set(watch.channelId, watch)
  }

  private issue(channelId: string, issue: string, needsRefresh: boolean) {
    const watch = this.watches.get(channelId)
    if (watch?.issue === issue && (!needsRefresh || watch.needsRefresh)) return
    if (watch) this.saveWatch({ ...watch, issue, needsRefresh: needsRefresh || watch.needsRefresh })
    reportRuntimeIssue('discord_archive_realtime', new Error(issue))
  }
}
