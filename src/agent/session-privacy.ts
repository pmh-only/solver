import { randomUUID } from 'node:crypto'
import { getStoredValue, setStoredValue } from '../helpers/kv-store.js'

interface SessionMode {
  private: boolean
  privateSession: string
}
function key(userId: string, sessionName: string) {
  return `gpt-session-privacy:${userId}:${encodeURIComponent(sessionName)}`
}
function fresh(privateMode: boolean): SessionMode {
  return {
    private: privateMode,
    privateSession: `__feature:private:${randomUUID().replace(/-/g, '')}`
  }
}

export function loadDiscordSessionMode(userId: string, sessionName: string): SessionMode {
  const raw = getStoredValue(key(userId, sessionName))
  if (raw === undefined) return fresh(false)
  try {
    const value: unknown = JSON.parse(raw)
    if (
      value &&
      typeof value === 'object' &&
      'private' in value &&
      typeof value.private === 'boolean' &&
      'privateSession' in value &&
      typeof value.privateSession === 'string' &&
      /^__feature:private:[a-f0-9]{32}$/.test(value.privateSession)
    )
      return value as SessionMode
  } catch {
    /* Corrupt visibility must never expose private history publicly. */
  }
  const mode = fresh(true)
  setStoredValue(key(userId, sessionName), JSON.stringify(mode))
  return mode
}

export function setDiscordSessionMode(
  userId: string,
  sessionName: string,
  privateMode: boolean
): SessionMode {
  const mode = { ...loadDiscordSessionMode(userId, sessionName), private: privateMode }
  setStoredValue(key(userId, sessionName), JSON.stringify(mode))
  return mode
}
