import { z } from 'zod'
import { deleteStoredValue, getStoredValue, setStoredValue } from './helpers/kv-store.js'

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
  action: z.enum(['get', 'update', 'reset']),
  guildId: z
    .string()
    .regex(/^\d{17,20}$/)
    .describe('Discord server ID for the guild-installed community commands'),
  // A PATCH must not inject defaults for omitted fields (Zod 4 also applies defaults
  // inside optional fields). Keep the update schema free of defaults.
  settings: z.object(communitySettingsFields).strict().partial().optional()
})

export type CommunitySettings = z.infer<typeof communitySettingsSchema>

export function loadCommunitySettings(scope: string): CommunitySettings {
  const raw = getStoredValue(`community:settings:${scope}`)
  if (!raw) return communitySettingsSchema.parse({})
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

export function manageCommunitySettings(input: unknown): CommunitySettings {
  const { action, guildId, settings } = manageCommunitySettingsSchema.parse(input)
  const key = `community:settings:${guildId}`
  if (action === 'reset') deleteStoredValue(key)
  if (action === 'update') {
    if (!settings) throw new Error('settings is required')
    const next = communitySettingsSchema.parse({ ...loadCommunitySettings(guildId), ...settings })
    setStoredValue(key, JSON.stringify(next))
  }
  return loadCommunitySettings(guildId)
}
