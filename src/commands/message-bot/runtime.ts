import type { Message } from 'discord.js'
import { z } from 'zod'
import { loadCommunitySettings } from '../../community-settings.js'
import { getStoredValue, setStoredValue } from '../../helpers/kv-store.js'
import { safeErrorMessage } from '../../safe-error.js'
import { defaultFoods } from '../community-foods.js'
import { fetchCommunityBytes } from '../community-http.js'
import { createOriginalBotCommands, type BotMessage, type SetRecord } from './core.js'

const MAX_SAVED_COMMANDS = 1000
const MAX_STORED_LENGTH = 3 * 1024 * 1024
const recordSchema = z
  .object({
    content: z.string().max(4000),
    authorId: z.string().regex(/^\d{17,20}$/)
  })
  .strict()
const recordsSchema = z
  .record(z.string().max(2000), recordSchema)
  .refine((records) => Object.keys(records).length <= MAX_SAVED_COMMANDS)

// A live per-guild view replaces the original global set.json. Each mutation reads
// the latest value synchronously, so overlapping message handlers cannot lose edits.
function savedCommands(guildId: string): Record<string, SetRecord> {
  const key = `community:message-bot:${guildId}`
  const read = (): Record<string, SetRecord> => {
    const raw = getStoredValue(key)
    if (!raw) return Object.create(null)
    try {
      if (raw.length > MAX_STORED_LENGTH) throw new Error('Oversized saved commands')
      const records = Object.assign(Object.create(null), recordsSchema.parse(JSON.parse(raw)))
      delete records.help
      delete records.list
      return records
    } catch {
      throw new Error('Saved commands are unavailable; reset them through /a.')
    }
  }
  const write = (records: Record<string, SetRecord>) => {
    recordsSchema.parse(records)
    const raw = JSON.stringify(records)
    if (raw.length > MAX_STORED_LENGTH) throw new Error('Saved command storage is full')
    setStoredValue(key, raw)
  }
  return new Proxy(Object.create(null) as Record<string, SetRecord>, {
    get: (_target, name) => (typeof name === 'string' ? read()[name] : undefined),
    ownKeys: () => Object.keys(read()),
    getOwnPropertyDescriptor: () => ({ enumerable: true, configurable: true }),
    set: (_target, name, value) => {
      if (typeof name !== 'string') return false
      if (name === '__proto__') throw new Error('Unsupported saved command key')
      const records = read()
      records[name] = value
      write(records)
      return true
    },
    deleteProperty: (_target, name) => {
      if (typeof name !== 'string') return false
      const records = read()
      delete records[name]
      write(records)
      return true
    }
  })
}

export async function fetchMessageBotJson(url: string): Promise<{ json(): Promise<unknown> }> {
  const parsed = new URL(url)
  const currencyUrl =
    parsed.origin === 'https://cdn.jsdelivr.net' &&
    /^\/npm\/@fawazahmed0\/currency-api@latest\/v1\/currencies\/\w*\.json$/.test(parsed.pathname) &&
    !parsed.search &&
    !parsed.hash &&
    !parsed.username &&
    !parsed.password
  if (!currencyUrl && url !== 'https://www.pizzint.watch/api/dashboard-data?nocache=1') {
    throw new Error('Unsupported command data URL')
  }
  const bytes = await fetchCommunityBytes(url, 1024 * 1024, [
    'cdn.jsdelivr.net',
    'www.pizzint.watch'
  ])
  return { json: async () => JSON.parse(bytes.toString('utf8')) }
}

export function createMessageBotHandler() {
  return async (message: Message): Promise<boolean> => {
    if (!message.guildId || message.author.bot || message.webhookId || message.system) return false
    let settings: ReturnType<typeof loadCommunitySettings>
    try {
      settings = loadCommunitySettings()
    } catch {
      return false
    }
    const { enabled, prefix } = settings.messageCommands
    if (
      !enabled ||
      (!message.content.startsWith(prefix) && !['점메추', '저메추'].includes(message.content))
    )
      return false
    const pendingReplies: Promise<unknown>[] = []
    const adapted: BotMessage = {
      content: message.content,
      author: message.author,
      reply: ({ content }) => {
        const bounded = content.length > 2000 ? `${content.slice(0, 1999)}…` : content
        // The original runners do not await replies. Collect and settle them here,
        // including failures, without introducing unhandled promise rejections.
        pendingReplies.push(
          Promise.resolve()
            .then(() =>
              message.reply({
                content: bounded,
                allowedMentions: { parse: [], repliedUser: false }
              })
            )
            .catch(() => {})
        )
      }
    }
    const original = createOriginalBotCommands({
      PREFIX: prefix,
      setData: savedCommands(message.guildId),
      saveSetData: () => {}, // The live SQLite view saves mutations immediately.
      foodData: settings.foods ?? defaultFoods,
      fetch: fetchMessageBotJson
    })
    for (const fn of original.fns) {
      try {
        await fn(message.client, adapted)
      } catch (error) {
        adapted.reply({
          content: 'error: ' + safeErrorMessage(error),
          allowedMentions: { parse: [] }
        })
      }
    }
    try {
      original.replyToSavedCommand(adapted)
    } catch (error) {
      adapted.reply({
        content: 'error: ' + safeErrorMessage(error),
        allowedMentions: { parse: [] }
      })
    }
    await Promise.all(pendingReplies)
    return true
  }
}
