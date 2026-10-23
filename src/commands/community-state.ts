import { z } from 'zod'
import {
  deleteStoredValue,
  getStoredValue,
  listStoredKeys,
  setStoredValue
} from '../helpers/kv-store.js'

export const discordId = z.string().regex(/^\d{17,20}$/)
const expiration = z.object({ expiresAt: z.number().int().positive() })

// Transient records are bounded globally, and lazily purged on reads/creation (no timers).
export function pruneCommunityState(slots = 1) {
  let count = 0
  for (const key of listStoredKeys()) {
    if (!key.startsWith('community:transient:')) continue
    try {
      const value = expiration.parse(JSON.parse(getStoredValue(key)!))
      if (value.expiresAt > Date.now()) {
        count++
        continue
      }
    } catch {
      /* Missing/corrupt state is expired. */
    }
    deleteStoredValue(key)
  }
  if (count > 200 - slots)
    throw new Error('진행 중인 요청이 너무 많습니다. 나중에 다시 시도하세요.')
}

export function saveCommunityState(key: string, value: unknown) {
  setStoredValue(`community:transient:${key}`, JSON.stringify(value))
}

export function deleteCommunityState(key: string) {
  deleteStoredValue(`community:transient:${key}`)
}

export function loadCommunityState<T>(key: string, schema: z.ZodType<T>): T | null {
  const raw = getStoredValue(`community:transient:${key}`)
  if (!raw) return null
  try {
    const parsed: unknown = JSON.parse(raw)
    const { expiresAt } = expiration.parse(parsed)
    if (expiresAt > Date.now()) return schema.parse(parsed)
  } catch {
    /* Treat corrupt state as expired. */
  }
  deleteCommunityState(key)
  return null
}
