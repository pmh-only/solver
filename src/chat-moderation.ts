import {
  MessageFlags,
  MessageType,
  type Message,
  type MessageReaction,
  type PartialMessageReaction,
  type User,
  type PartialUser
} from 'discord.js'
import OpenAI from 'openai'
import { z } from 'zod'
import { loadCommunitySettings } from './community-settings.js'
import { container, text } from './components.js'
import { getStoredValue, setStoredValue } from './helpers/kv-store.js'
import { loadOpenAIApiKey, loadOpenAIEndpoint } from './openai-config.js'
import { clearRuntimeIssue, reportRuntimeIssue } from './runtime-health.js'

export const MODERATION_WARNING = '⚠️'
const KEY = 'community:chat-moderation'
const RETENTION = 7 * 24 * 60 * 60_000
const MAX_RECORDS = 1000
const labels = {
  harassment: '괴롭힘',
  'harassment/threatening': '위협적 괴롭힘',
  hate: '혐오',
  'hate/threatening': '위협적 혐오',
  illicit: '불법 행위',
  'illicit/violent': '폭력적 불법 행위',
  'self-harm': '자해',
  'self-harm/intent': '자해 의도',
  'self-harm/instructions': '자해 방법',
  sexual: '성적 콘텐츠',
  'sexual/minors': '미성년자 성적 콘텐츠',
  violence: '폭력',
  'violence/graphic': '노골적인 폭력'
} as const
const categorySchema = z.enum(
  Object.keys(labels) as [keyof typeof labels, ...(keyof typeof labels)[]]
)
const resultSchema = z.object({
  flagged: z.boolean(),
  categories: z.record(z.string(), z.boolean().nullable())
})
const recordSchema = z
  .object({
    categories: z.array(categorySchema).min(1).max(13),
    createdAt: z.number().int().positive(),
    shownAt: z.number().int().nonnegative()
  })
  .strict()
const recordsSchema = z
  .record(z.string().regex(/^\d{17,20}:\d{17,20}:\d{17,20}$/), recordSchema)
  .refine((records) => Object.keys(records).length <= MAX_RECORDS)

function readRecords() {
  const raw = getStoredValue(KEY)
  if (!raw) return {}
  if (raw.length > 1024 * 1024) throw new Error('Oversized moderation state')
  const parsed = recordsSchema.safeParse(JSON.parse(raw))
  if (!parsed.success) throw new Error('Invalid moderation state')
  const entries = Object.entries(parsed.data).filter(
    ([, item]) => item.createdAt <= Date.now() && item.createdAt > Date.now() - RETENTION
  )
  const records = Object.fromEntries(entries)
  if (entries.length !== Object.keys(parsed.data).length)
    setStoredValue(KEY, JSON.stringify(records))
  return records
}

function saveRecord(key: string, record: z.infer<typeof recordSchema>) {
  const records = readRecords()
  records[key] = record
  setStoredValue(
    KEY,
    JSON.stringify(
      Object.fromEntries(
        Object.entries(records)
          .sort((a, b) => b[1].createdAt - a[1].createdAt)
          .slice(0, MAX_RECORDS)
      )
    )
  )
}

async function classify(input: string) {
  const apiKey = loadOpenAIApiKey()
  if (!apiKey)
    throw new Error('Configure the OpenAI credential privately through /a for chat moderation')
  const client = new OpenAI({
    apiKey,
    baseURL: loadOpenAIEndpoint(),
    timeout: 10_000,
    maxRetries: 0
  })
  const response = await client.moderations.create({ model: 'omni-moderation-latest', input })
  return response.results[0]
}

// No message content, author IDs, credentials or scores are persisted.
export function createChatModerationHandler(
  moderate: (input: string) => Promise<unknown> = classify
) {
  let active = 0
  let windowStart = Date.now()
  let attempts = 0
  const inFlight = new Set<string>()
  return async (message: Message): Promise<void> => {
    if (
      !message.guildId ||
      message.author.bot ||
      message.webhookId ||
      ![MessageType.Default, MessageType.Reply].includes(message.type) ||
      !message.content.trim()
    )
      return
    try {
      const settings = loadCommunitySettings().chatModeration
      if (!settings.enabled) return
      const key = `${message.guildId}:${message.channelId}:${message.id}`
      if (inFlight.has(key) || readRecords()[key]) return
      if (Date.now() - windowStart >= 60_000) {
        windowStart = Date.now()
        attempts = 0
      }
      if (active >= 4 || attempts >= settings.requestsPerMinute) {
        reportRuntimeIssue(
          'chat_moderation_capacity',
          new Error('Chat moderation capacity exceeded; some messages were not checked')
        )
        return
      }
      active++
      attempts++
      inFlight.add(key)
      try {
        const result = resultSchema.parse(await moderate(message.content.slice(0, 4000)))
        if (!loadCommunitySettings().chatModeration.enabled) return
        const categories = categorySchema.options.filter(
          (category) => result.categories[category] === true
        )
        if (result.flagged && categories.length) {
          saveRecord(key, { categories, createdAt: Date.now(), shownAt: 0 })
          await message.react(MODERATION_WARNING)
        }
        clearRuntimeIssue('chat_moderation')
      } finally {
        active--
        inFlight.delete(key)
      }
    } catch {
      // Provider/Discord errors may contain submitted text or secrets.
      reportRuntimeIssue(
        'chat_moderation',
        new Error(
          'Chat moderation failed; check OpenAI configuration and Discord reaction permissions through /a'
        )
      )
    }
  }
}

export function createModerationReactionHandler() {
  return async (
    reaction: MessageReaction | PartialMessageReaction,
    user: User | PartialUser
  ): Promise<void> => {
    const message = reaction.message
    if (
      user.bot ||
      !message.guildId ||
      reaction.emoji.id ||
      reaction.emoji.name?.replace(/\uFE0F/g, '') !== '⚠'
    )
      return
    try {
      if (!loadCommunitySettings().chatModeration.enabled) return
      const actor = user.partial ? await user.fetch() : user
      if (actor.bot) return
      const key = `${message.guildId}:${message.channelId}:${message.id}`
      const record = readRecords()[key]
      if (!record || (record.shownAt && Date.now() - record.shownAt < 60_000)) return
      // Reserve before awaiting to coalesce duplicate/concurrent clicks.
      const previous = record.shownAt
      record.shownAt = Date.now()
      saveRecord(key, record)
      try {
        const source = await message.fetch()
        if (
          source.guildId !== message.guildId ||
          source.channelId !== message.channelId ||
          source.id !== message.id
        )
          return
        if (!loadCommunitySettings().chatModeration.enabled) return
        await source.reply({
          components: container(
            'chat moderation',
            new Map(),
            text(
              `### ⚠️ 채팅 검토 결과\n${record.categories.map((category) => `- ${labels[category]} (${category})`).join('\n')}\n-# OpenAI 자동 감지 결과이며 오탐일 수 있습니다. 동일 메시지 안내는 1분에 한 번 표시됩니다.`
            )
          ).components.slice(0, 1),
          flags: MessageFlags.IsComponentsV2,
          allowedMentions: { parse: [], repliedUser: false }
        })
      } catch {
        saveRecord(key, { ...record, shownAt: previous })
        throw new Error('Moderation result delivery failed')
      }
    } catch {
      reportRuntimeIssue(
        'chat_moderation_reaction',
        new Error('Could not display moderation results in the source channel')
      )
    }
  }
}
