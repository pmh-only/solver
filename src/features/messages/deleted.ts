import { Events, MessageType, type Client, type Message, type PartialMessage } from 'discord.js'
import { loadCommunitySettings } from '../community/settings.js'
import { reportRuntimeIssue } from '../../shared/runtime/health.js'

type DeletedMessage = {
  id: string
  authorId: string
  content: string
  attachments: string[]
  deletedAt: number
}

// Independent of the archive: never make archive-only/deleted private data searchable.
// At most 200 channels * 5 bounded records, with no URLs, files or disk persistence.
export class DeletedMessageHistory {
  private readonly channels = new Map<string, DeletedMessage[]>()

  clear(): void {
    this.channels.clear()
  }

  private prune(): boolean {
    const settings = loadCommunitySettings()
    if (!settings.deletedMessages.enabled || settings.disabledCommands.includes('deleted')) {
      this.clear()
      return false
    }
    const cutoff = Date.now() - settings.deletedMessages.retentionMinutes * 60_000
    for (const [key, records] of this.channels) {
      const kept = records.filter((record) => record.deletedAt > cutoff)
      if (kept.length) this.channels.set(key, kept)
      else this.channels.delete(key)
    }
    return true
  }

  capture(message: Message | PartialMessage): void {
    try {
      if (!this.prune()) return
      if (
        !message.guildId ||
        message.partial ||
        !message.author ||
        message.author.bot ||
        message.webhookId ||
        ![MessageType.Default, MessageType.Reply].includes(message.type) ||
        (!message.content.trim() && !message.attachments.size)
      )
        return
      const key = `${message.guildId}:${message.channelId}`
      const records = this.channels.get(key) ?? []
      if (records.some((record) => record.id === message.id)) return
      records.unshift({
        id: message.id,
        authorId: message.author.id,
        content: message.content.slice(0, 1000),
        attachments: [...message.attachments.values()]
          .slice(0, 3)
          .map((item) => (item.name ?? '파일').slice(0, 100)),
        deletedAt: Date.now()
      })
      this.channels.delete(key)
      this.channels.set(key, records.slice(0, 5))
      if (this.channels.size > 200) this.channels.delete(this.channels.keys().next().value!)
    } catch {
      this.clear()
      reportRuntimeIssue(
        'deleted_messages',
        new Error('Deleted-message tracking failed; check /a community settings')
      )
    }
  }

  recent(guildId: string, channelId: string): readonly DeletedMessage[] {
    if (!this.prune()) return []
    return this.channels.get(`${guildId}:${channelId}`) ?? []
  }
}

export const deletedMessageHistory = new DeletedMessageHistory()

export function registerDeletedMessageTracking(client: Client): void {
  client.on(Events.MessageDelete, (message) => deletedMessageHistory.capture(message))
  client.on(Events.MessageBulkDelete, (messages) => {
    for (const message of messages.values()) deletedMessageHistory.capture(message)
  })
}
