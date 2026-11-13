import {
  EmbedBuilder,
  MessageType,
  Routes,
  type Message,
  type PartialMessage,
  type MessageReaction,
  type PartialMessageReaction,
  type User,
  type PartialUser
} from 'discord.js'
import OpenAI from 'openai'
import { z } from 'zod'
import { loadCommunitySettings } from '../community/settings.js'
import { getStoredValue, setStoredValue } from '../../shared/storage/kv-store.js'
import { loadOpenAIApiKey, loadOpenAIEndpoint } from '../../integrations/openai/config.js'
import { clearRuntimeIssue, reportRuntimeIssue } from '../../shared/runtime/health.js'
import {
  buildModerationInput,
  moderationSnapshot,
  type ModerationInput,
  type ModerationSnapshot
} from './input.js'

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
  categories: z.record(z.string(), z.boolean().nullable()),
  category_scores: z.record(z.string(), z.number().min(0).max(1)).optional()
})
const recordSchema = z
  .object({
    categories: z.array(categorySchema).min(1).max(13),
    createdAt: z.number().int().positive(),
    shownAt: z.number().int().nonnegative(),
    signature: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .optional(),
    scores: z.partialRecord(categorySchema, z.number().min(0).max(1)).optional(),
    incomplete: z.boolean().optional()
  })
  .strict()
const recordsSchema = z
  .record(z.string().regex(/^\d{17,20}:\d{17,20}:\d{17,20}$/), recordSchema)
  .refine((records) => Object.keys(records).length <= MAX_RECORDS)

function hasScores(record: z.infer<typeof recordSchema>): boolean {
  return record.categories.every((category) => typeof record.scores?.[category] === 'number')
}

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

function deleteRecord(key: string) {
  const records = readRecords()
  if (records[key]) {
    delete records[key]
    setStoredValue(KEY, JSON.stringify(records))
  }
}

async function classify(input: ModerationInput) {
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

// Persist only message-scoped results and a content fingerprint, never original inputs or URLs.
export function createChatModerationHandler(
  moderate: (input: ModerationInput) => Promise<unknown> = classify
) {
  let active = 0
  let windowStart = Date.now()
  let attempts = 0
  const jobs = new Map<string, { snapshot: ModerationSnapshot; promise: Promise<void> }>()
  const completed = new Map<string, string>()
  async function check(snapshot: ModerationSnapshot, isCurrent: () => boolean) {
    const { message, signature } = snapshot
    const key = `${message.guildId}:${message.channelId}:${message.id}`
    const previous = readRecords()[key]
    if (
      (previous?.signature === signature && hasScores(previous)) ||
      completed.get(key) === signature
    )
      return
    completed.delete(key)
    // Invalidate known stale revisions immediately. Keep scoreless records for
    // retry on a refresh failure; reaction replies always recheck these first.
    if (previous?.signature && previous.signature !== signature) deleteRecord(key)
    if (Date.now() - windowStart >= 60_000) {
      windowStart = Date.now()
      attempts = 0
    }
    if (active >= 4 || attempts >= loadCommunitySettings().chatModeration.requestsPerMinute) {
      reportRuntimeIssue(
        'chat_moderation_capacity',
        new Error('Chat moderation capacity exceeded; some messages were not checked')
      )
      return
    }
    active++
    attempts++
    try {
      const { input, incomplete } = await buildModerationInput(snapshot)
      if (incomplete)
        reportRuntimeIssue(
          'chat_moderation_attachments',
          new Error(
            'Some attachments could not be checked: unsupported format, size limit or download failure'
          )
        )
      if (!isCurrent() || !loadCommunitySettings().chatModeration.enabled) return
      if (input === undefined) {
        if (incomplete) return
      }
      const result =
        input === undefined
          ? { flagged: false, categories: {}, category_scores: undefined }
          : resultSchema.parse(await moderate(input))
      if (!isCurrent() || !loadCommunitySettings().chatModeration.enabled) return
      const categories = categorySchema.options.filter(
        (category) => result.categories[category] === true
      )
      if (result.flagged && categories.length) {
        const scores = result.category_scores
          ? Object.fromEntries(
              categories.flatMap((category) => {
                const score = result.category_scores?.[category]
                return score === undefined ? [] : [[category, score]]
              })
            )
          : undefined
        saveRecord(key, {
          categories,
          scores,
          signature,
          incomplete,
          createdAt: Date.now(),
          shownAt: 0
        })
        if (!categories.every((category) => typeof scores?.[category] === 'number')) {
          reportRuntimeIssue(
            'chat_moderation_scores',
            new Error(
              'Moderation provider omitted category_scores for detected categories; check the configured OpenAI endpoint through /a'
            )
          )
        } else {
          clearRuntimeIssue('chat_moderation_scores')
        }
        await message.react(MODERATION_WARNING)
      } else if (
        !incomplete &&
        (previous ||
          message.reactions.cache.some(
            (item) => item.me && item.emoji.name?.replace(/\uFE0F/g, '') === '⚠'
          ))
      ) {
        if (previous) deleteRecord(key)
        await message.client.rest.delete(
          Routes.channelMessageOwnReaction(
            message.channelId,
            message.id,
            encodeURIComponent(MODERATION_WARNING)
          )
        )
      }
      if (!result.flagged && !incomplete && isCurrent()) {
        completed.delete(key)
        completed.set(key, signature)
        if (completed.size > MAX_RECORDS) completed.delete(completed.keys().next().value!)
      }
      clearRuntimeIssue('chat_moderation')
    } finally {
      active--
    }
  }
  return async (partial: Message | PartialMessage): Promise<void> => {
    if (!partial.guildId) return
    try {
      if (!loadCommunitySettings().chatModeration.enabled) return
      const message = partial.partial ? await partial.fetch() : partial
      if (
        !message.guildId ||
        message.author.bot ||
        message.webhookId ||
        ![MessageType.Default, MessageType.Reply].includes(message.type)
      )
        return
      const key = `${message.guildId}:${message.channelId}:${message.id}`
      const snapshot = moderationSnapshot(message)
      const existing = jobs.get(key)
      if (existing) {
        existing.snapshot = snapshot
        await existing.promise
        return
      }
      if (jobs.size >= 250) {
        reportRuntimeIssue(
          'chat_moderation_capacity',
          new Error('Too many pending moderation checks')
        )
        return
      }
      const job = { snapshot, promise: Promise.resolve() }
      jobs.set(key, job)
      job.promise = (async () => {
        try {
          let checked: string
          do {
            const current = job.snapshot
            checked = current.signature
            try {
              await check(current, () => job.snapshot.signature === checked)
            } catch (error) {
              if (job.snapshot.signature === checked) throw error
            }
          } while (job.snapshot.signature !== checked)
        } finally {
          jobs.delete(key)
        }
      })()
      await job.promise
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

export function createModerationReactionHandler(recheck = createChatModerationHandler()) {
  const pending = new Set<string>()
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
    const key = `${message.guildId}:${message.channelId}:${message.id}`
    if (pending.has(key) || pending.size >= 250) return
    pending.add(key)
    try {
      if (!loadCommunitySettings().chatModeration.enabled) return
      const actor = user.partial ? await user.fetch() : user
      if (actor.bot) return
      let record = readRecords()[key]
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
        if (record.signature && moderationSnapshot(source).signature !== record.signature) return
        const latest = readRecords()[key]
        if (!latest || latest.signature !== record.signature) return
        // Pre-score records (and incomplete provider responses) must not remain
        // permanently scoreless just because the message itself hasn't changed.
        if (!record.signature || !hasScores(record)) {
          await recheck(source)
          if (!loadCommunitySettings().chatModeration.enabled) return
          const refreshed = readRecords()[key]
          if (!refreshed || refreshed.signature !== moderationSnapshot(source).signature) return
          record = { ...refreshed, shownAt: Date.now() }
          saveRecord(key, record)
        }
        await source.reply({
          embeds: [
            new EmbedBuilder()
              .setColor(0xf1c40f)
              .setTitle('⚠️ 채팅 검토 결과')
              .setDescription(
                record.categories
                  .map((category) => {
                    const score = record.scores?.[category]
                    return `- ${labels[category]} (${category}): **${score === undefined ? '점수 조회 불가 (잠시 후 재시도)' : `${(score * 100).toFixed(2)}%`}**`
                  })
                  .join('\n')
              )
              .setFooter(record.incomplete ? { text: '일부 첨부파일 검사 불가' } : null)
          ],
          allowedMentions: { parse: [], repliedUser: false }
        })
      } catch {
        const latest = readRecords()[key]
        if (latest && latest.signature === record.signature)
          saveRecord(key, { ...record, shownAt: previous })
        throw new Error('Moderation result delivery failed')
      }
    } catch {
      reportRuntimeIssue(
        'chat_moderation_reaction',
        new Error('Could not display moderation results in the source channel')
      )
    } finally {
      pending.delete(key)
    }
  }
}
