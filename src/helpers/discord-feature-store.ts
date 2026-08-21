import { z } from 'zod'
import { getStoredValue, setStoredValue } from './kv-store.js'

export const DISCORD_FEATURES_KEY = 'gpt-discord-features'
export const MAX_STORED_DISCORD_FEATURES = 32

export const discordFeatureIdSchema = z
  .string()
  .trim()
  .min(1)
  .max(32)
  .regex(/^[a-z0-9][a-z0-9_-]*$/)

export const storedDiscordFeatureSchema = z
  .object({
    id: discordFeatureIdSchema,
    kind: z.enum(['command', 'user', 'message']),
    name: z.string().trim().min(1).max(32),
    description: z.string().trim().min(1).max(100),
    instructions: z.string().trim().min(1).max(16_000)
  })
  .superRefine((feature, context) => {
    if (feature.kind === 'command' && !/^[a-z0-9][a-z0-9_-]{0,31}$/.test(feature.name)) {
      context.addIssue({
        code: 'custom',
        path: ['name'],
        message:
          '/c feature names must contain only lowercase letters, numbers, underscores, or hyphens'
      })
    }
    if (feature.kind !== 'command' && /[\r\n]/.test(feature.name)) {
      context.addIssue({
        code: 'custom',
        path: ['name'],
        message: 'Context command names must be a single line'
      })
    }
  })

const storedDiscordFeaturesSchema = z
  .array(storedDiscordFeatureSchema)
  .max(MAX_STORED_DISCORD_FEATURES)
  .refine(
    (features) => new Set(features.map(({ id }) => id)).size === features.length,
    'Discord feature ids must be unique'
  )
  .refine(
    (features) =>
      new Set(features.map(({ kind, name }) => `${kind}:${name.toLowerCase()}`)).size ===
      features.length,
    'Discord feature command identities must be unique'
  )

export type StoredDiscordFeature = z.infer<typeof storedDiscordFeatureSchema>

export function loadStoredDiscordFeatures(): StoredDiscordFeature[] {
  const stored = getStoredValue(DISCORD_FEATURES_KEY)
  if (!stored) return []
  try {
    const parsed = storedDiscordFeaturesSchema.safeParse(JSON.parse(stored))
    return parsed.success ? parsed.data : []
  } catch {
    return []
  }
}

export function storeDiscordFeatures(features: StoredDiscordFeature[]): void {
  setStoredValue(DISCORD_FEATURES_KEY, JSON.stringify(storedDiscordFeaturesSchema.parse(features)))
}
