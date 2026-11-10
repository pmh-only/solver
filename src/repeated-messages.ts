import { createHash } from 'node:crypto'
import { EmbedBuilder, MessageType, type Message } from 'discord.js'
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

async function notifyRoleAssignment(message: Message, roleId: string): Promise<void> {
  try {
    const channelId = loadCommunitySettings().automodChannelId
    if (!channelId) return
    const channel = await message.guild!.channels.fetch(channelId)
    if (!channel?.isSendable() || channel.guildId !== message.guildId)
      throw new Error('Invalid automod destination')
    if (loadCommunitySettings().automodChannelId !== channelId) return
    await channel.send({
      embeds: [
        new EmbedBuilder()
          .setColor(0xf1c40f)
          .setTitle('반복 메시지 역할 부여')
          .addFields(
            { name: '사용자', value: `<@${message.author.id}> (${message.author.id})` },
            { name: '부여 역할', value: `<@&${roleId}>` },
            {
              name: '원본 메시지',
              value: `https://discord.com/channels/${message.guildId}/${message.channelId}/${message.id}`
            }
          )
          .setDescription(
            `**반복 내용**\n${message.content.length > 3000 ? `${message.content.slice(0, 2999)}…` : message.content}`
          )
          .setTimestamp()
      ],
      allowedMentions: { parse: [], repliedUser: false }
    })
    clearRuntimeIssue('repeated_messages_log')
  } catch {
    reportRuntimeIssue(
      'repeated_messages_log',
      new Error(
        'Could not send repeated-message log; check /a automodChannelId and channel permissions'
      )
    )
  }
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
        const alreadyAssigned = member.roles.cache.has(settings.roleId)
        if (!alreadyAssigned)
          await member.roles.add(settings.roleId, 'Identical message sent at least five times')
        record.assigned = true
        clearRuntimeIssue('repeated_messages')
        if (!alreadyAssigned) await notifyRoleAssignment(message, settings.roleId)
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
