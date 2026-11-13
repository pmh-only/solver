import { getStoredValue, listStoredKeys, setStoredValue } from './kv-store.js'

export const ENVIRONMENT_KEY_PREFIX = 'env:'

export function setStoredEnvironmentValue(key: string, value: string): void {
  process.env[key] = value
  setStoredValue(`${ENVIRONMENT_KEY_PREFIX}${key}`, value)
}

export function restoreStoredEnvironment(): void {
  for (const storedKey of listStoredKeys()) {
    if (!storedKey.startsWith(ENVIRONMENT_KEY_PREFIX)) continue

    const key = storedKey.slice(ENVIRONMENT_KEY_PREFIX.length)
    const value = getStoredValue(storedKey)
    if (key && value !== undefined) process.env[key] = value
  }
}
