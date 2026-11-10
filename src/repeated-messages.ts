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
  unchecked: number
}

function failureDetail(stage: string, error: unknown): string {
  const code = error && typeof error === 'object' && 'code' in error ? error.code : undefined
  const status = error && typeof error === 'object' && 'status' in error ? error.status : undefined
  // Never include provider messages, request bodies, URLs or headers in diagnostics.
  return `stage=${stage}; discord_code=${typeof code === 'number' && Number.isSafeInteger(code) ? code : 'unknown'}; http_status=${typeof status === 'number' && Number.isSafeInteger(status) ? status : 'unknown'}`
}

async function notifyRoleAssignment(message: Message, roleId: string): Promise<void> {
  let stage = 'log_configuration'
  try {
    const channelId = loadCommunitySettings().automodChannelId
    if (!channelId) return
    stage = 'log_channel_fetch'
    const channel = await message.guild!.channels.fetch(channelId, { force: true })
    if (!channel?.isSendable() || channel.guildId !== message.guildId)
      throw new Error('Invalid automod destination')
    if (loadCommunitySettings().automodChannelId !== channelId) return
    stage = 'log_send'
    await channel.send({
      // Plain text deliberately needs no Embed Links permission.
      content: [
        '**반복 메시지 역할 부여**',
        `사용자: <@${message.author.id}> (${message.author.id})`,
        `부여 역할: <@&${roleId}>`,
        `원본: https://discord.com/channels/${message.guildId}/${message.channelId}/${message.id}`,
        '**반복 내용**',
        message.content.length > 1500 ? `${message.content.slice(0, 1499)}…` : message.content
      ].join('\n'),
      allowedMentions: { parse: [], repliedUser: false }
    })
    clearRuntimeIssue('repeated_messages_log')
  } catch (error) {
    reportRuntimeIssue(
      'repeated_messages_log',
      new Error(
        `Could not send repeated-message log; ${failureDetail(stage, error)}; check /a automodChannelId and channel permissions`
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
    let stage = 'configuration'
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
        record = { messages: [], lastSeen: now, pending: false, unchecked: 0 }
        records.set(key, record)
      }
      record.messages = record.messages.filter((item) => item.at > cutoff)
      if (record.messages.some((item) => item.id === message.id)) return
      record.messages.push({ id: message.id, at: now })
      record.messages = record.messages.slice(-THRESHOLD)
      record.unchecked = Math.min(THRESHOLD, record.unchecked + 1)
      record.lastSeen = now
      if (
        record.messages.length < THRESHOLD ||
        record.pending ||
        record.unchecked < THRESHOLD ||
        (record.attemptedAt !== undefined && now - record.attemptedAt < 60_000)
      )
        return
      record.pending = true
      record.attemptedAt = now
      try {
        stage = 'member_fetch'
        // GuildMembers intent is not enabled, so cached roles can miss manual removals.
        const member = await message.guild.members.fetch({ user: message.author.id, force: true })
        // Settings may have changed while fetching an uncached member.
        if (JSON.stringify(loadCommunitySettings().repeatedMessages) !== signature) return
        const alreadyAssigned = member.roles.cache.has(settings.roleId)
        stage = 'role_add'
        if (!alreadyAssigned)
          await member.roles.add(settings.roleId, 'Identical message sent at least five times')
        record.unchecked = 0
        record.attemptedAt = undefined
        clearRuntimeIssue('repeated_messages')
        if (!alreadyAssigned) await notifyRoleAssignment(message, settings.roleId)
      } finally {
        record.pending = false
      }
    } catch (error) {
      reportRuntimeIssue(
        'repeated_messages',
        new Error(
          `Repeated-message role assignment failed; ${failureDetail(stage, error)}; check /a settings and Manage Roles/role hierarchy`
        )
      )
    }
  }
}
