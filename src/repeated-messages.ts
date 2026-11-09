import { createHash } from 'node:crypto'
import { MessageType, type Message } from 'discord.js'
import { loadCommunitySettings } from './community-settings.js'
import { clearRuntimeIssue, reportRuntimeIssue } from './runtime-health.js'

const MAX_RECORDS = 5000
const THRESHOLD = 5
type Record = {
  messages: { id: string; at: number }[]
  lastSeen: number
  attemptedAt?: number
  pending: boolean
  assigned: boolean
}

// Only fingerprints and bounded transient metadata are retained, never message text.
export function createRepeatedMessageHandler() {
  const records = new Map<string, Record>()
  let configuration = ''
  return async (message: Message): Promise<void> => {
    if (
      !message.guildId ||
      !message.guild ||
      message.author.bot ||
      message.webhookId ||
      ![MessageType.Default, MessageType.Reply].includes(message.type) ||
      !message.content?.trim()
    )
      return
    try {
      const settings = loadCommunitySettings().repeatedMessages
      const signature = JSON.stringify(settings)
      if (configuration !== signature) {
        records.clear()
        configuration = signature
      }
      if (!settings) return
      const now = Date.now()
      const cutoff = now - settings.windowSeconds * 1000
      for (const [key, record] of records) {
        if (record.lastSeen <= cutoff && !record.pending) records.delete(key)
      }
      const hash = createHash('sha256').update(message.content).digest('hex')
      const key = `${message.guildId}:${message.channelId}:${message.author.id}:${hash}`
      let record = records.get(key)
      if (!record) {
        if (records.size >= MAX_RECORDS) records.delete(records.keys().next().value!)
        record = { messages: [], lastSeen: now, pending: false, assigned: false }
        records.set(key, record)
      }
      record.messages = record.messages.filter((item) => item.at > cutoff)
      if (record.messages.some((item) => item.id === message.id)) return
      record.messages.push({ id: message.id, at: now })
      record.messages = record.messages.slice(-THRESHOLD)
      record.lastSeen = now
      if (
        record.messages.length < THRESHOLD ||
        record.pending ||
        record.assigned ||
        (record.attemptedAt !== undefined && now - record.attemptedAt < 60_000)
      )
        return
      record.pending = true
      record.attemptedAt = now
      try {
        const member = message.member ?? (await message.guild.members.fetch(message.author.id))
        // Settings may have changed while fetching an uncached member.
        if (JSON.stringify(loadCommunitySettings().repeatedMessages) !== signature) return
        if (!member.roles.cache.has(settings.roleId))
          await member.roles.add(settings.roleId, 'Identical message sent at least five times')
        record.assigned = true
        clearRuntimeIssue('repeated_messages')
      } finally {
        record.pending = false
      }
    } catch {
      reportRuntimeIssue(
        'repeated_messages',
        new Error(
          'Repeated-message role assignment failed; check /a settings and Manage Roles/role hierarchy'
        )
      )
    }
  }
}
