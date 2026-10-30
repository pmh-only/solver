import { z } from 'zod'
import {
  deleteStoredValue,
  getStoredValue,
  listStoredKeys,
  setStoredValue
} from './helpers/kv-store.js'

export const COMMUNITY_SETTINGS_KEY = 'community:settings'

export const personaSchema = z
  .object({
    name: z
      .string()
      .trim()
      .min(1)
      .max(40)
      .regex(/^[\p{L}\p{N}_-]+$/u),
    prompt: z.string().trim().min(1).max(4000)
  })
  .strict()

const personasSchema = z
  .array(personaSchema)
  .max(100)
  .refine(
    (items) => new Set(items.map((item) => item.name)).size === items.length,
    'Persona names must be unique'
  )

export const communityCommandNames = [
  'food',
  'pizza',
  'now',
  'date',
  'anon',
  'color',
  'invite',
  'emoji',
  'kickvote'
] as const
export const foodSchema = z
  .object({
    name: z.string().trim().min(1).max(80),
    tags: z.array(z.string().trim().min(1).max(30)).max(10)
  })
  .strict()

const communitySettingsFields = {
  personas: personasSchema,
  reactionForward: z
    .object({ channelId: z.string().regex(/^\d{17,20}$/) })
    .strict()
    .nullable(),
  messageCommands: z
    .object({
      enabled: z.boolean().default(true),
      prefix: z.string().min(1).max(10).regex(/^\S+$/).default('!!')
    })
    .strict(),
  roleChat: z
    .object({
      roleId: z.string().regex(/^\d{17,20}$/),
      randomReplyChance: z.number().min(0).max(1).default(0.01),
      webSearch: z.boolean().default(true),
      model: z.string().trim().min(1).max(100).default('gpt-5.4'),
      systemPrompt: z.string().trim().max(4000).default('친절하고 간결하게 대화하세요.'),
      maxOutputTokens: z.number().int().min(256).max(4096).default(1024)
    })
    .strict()
    .nullable(),
  disabledCommands: z.array(z.enum(communityCommandNames)).max(communityCommandNames.length),
  inviteChannelId: z
    .string()
    .regex(/^\d{17,20}$/)
    .nullable(),
  kickvoteChannelId: z
    .string()
    .regex(/^\d{17,20}$/)
    .nullable(),
  kickvoteThreshold: z.number().int().min(2).max(100),
  kickvoteIdleMinutes: z.number().int().min(1).max(120),
  inviteMaxAgeHours: z.number().int().min(1).max(168),
  inviteCooldownHours: z.number().int().min(1).max(168),
  anonymousName: z.string().trim().min(1).max(80),
  foods: z.array(foodSchema).min(1).max(200).nullable()
}

export const communitySettingsSchema = z
  .object({
    personas: communitySettingsFields.personas.default([]),
    reactionForward: communitySettingsFields.reactionForward.default(null),
    messageCommands: communitySettingsFields.messageCommands.default({
      enabled: true,
      prefix: '!!'
    }),
    roleChat: communitySettingsFields.roleChat.default(null),
    disabledCommands: communitySettingsFields.disabledCommands.default([]),
    inviteChannelId: communitySettingsFields.inviteChannelId.default(null),
    kickvoteChannelId: communitySettingsFields.kickvoteChannelId.default(null),
    kickvoteThreshold: communitySettingsFields.kickvoteThreshold.default(7),
    kickvoteIdleMinutes: communitySettingsFields.kickvoteIdleMinutes.default(30),
    inviteMaxAgeHours: communitySettingsFields.inviteMaxAgeHours.default(12),
    inviteCooldownHours: communitySettingsFields.inviteCooldownHours.default(24),
    anonymousName: communitySettingsFields.anonymousName.default('???'),
    foods: communitySettingsFields.foods.default(null)
  })
  .strict()

export const manageCommunitySettingsSchema = z.object({
  action: z.enum(['get', 'update', 'reset', 'reset-message-replies', 'reset-reaction-forwards']),
  // A PATCH must not inject defaults for omitted fields (Zod 4 also applies defaults
  // inside optional fields). Keep the update schema free of defaults.
  settings: z.object(communitySettingsFields).strict().partial().optional()
})

export type CommunitySettings = z.infer<typeof communitySettingsSchema>

function parseCommunitySettings(raw: string): CommunitySettings {
  // Fail closed on corrupt configuration instead of silently re-enabling moderation actions.
  const stored: unknown = JSON.parse(raw)
  if (stored && typeof stored === 'object' && !Array.isArray(stored)) {
    const fields = stored as Record<string, unknown>
    if (fields.roleChat && typeof fields.roleChat === 'object' && !Array.isArray(fields.roleChat)) {
      // Existing configurations must keep working after removing these obsolete limits.
      const roleChat = { ...fields.roleChat } as Record<string, unknown>
      delete roleChat.cooldownSeconds
      delete roleChat.requestsPerHour
      return communitySettingsSchema.parse({ ...fields, roleChat })
    }
  }
  return communitySettingsSchema.parse(stored)
}

export function loadCommunitySettings(): CommunitySettings {
  const raw = getStoredValue(COMMUNITY_SETTINGS_KEY)
  if (raw !== undefined) return parseCommunitySettings(raw)
  const legacy = listStoredKeys().filter((key) => /^community:settings:\d{17,20}$/.test(key))
  if (!legacy.length) {
    const defaults = communitySettingsSchema.parse({})
    setStoredValue(COMMUNITY_SETTINGS_KEY, JSON.stringify(defaults))
    return defaults
  }
  const previous = legacy.map((key) => parseCommunitySettings(getStoredValue(key)!))
  const serialized = JSON.stringify(previous[0])
  if (previous.some((settings) => JSON.stringify(settings) !== serialized)) {
    throw new Error('기존 서버 설정이 서로 다릅니다. /a에서 전역 설정을 초기화한 뒤 설정하세요.')
  }
  // Keep old keys as backups; all current readers use only the single global key.
  setStoredValue(COMMUNITY_SETTINGS_KEY, serialized)
  return previous[0]!
}

export function manageCommunitySettings(input: unknown): CommunitySettings {
  const { action, settings } = manageCommunitySettingsSchema.parse(input)
  if (action === 'reset') {
    // An explicit global default prevents legacy backups from being restored on the next read.
    setStoredValue(COMMUNITY_SETTINGS_KEY, JSON.stringify(communitySettingsSchema.parse({})))
  }
  const resetPrefix =
    action === 'reset-message-replies'
      ? 'community:message-bot:'
      : action === 'reset-reaction-forwards'
        ? 'community:reaction-forward:'
        : null
  if (resetPrefix) {
    for (const key of listStoredKeys()) if (key.startsWith(resetPrefix)) deleteStoredValue(key)
  }
  if (action === 'update') {
    if (!settings) throw new Error('settings is required')
    const next = communitySettingsSchema.parse({ ...loadCommunitySettings(), ...settings })
    setStoredValue(COMMUNITY_SETTINGS_KEY, JSON.stringify(next))
  }
  return loadCommunitySettings()
}
