import { DatabaseSync } from 'node:sqlite'
import { chmodSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

import { getDefaultKvStorePath } from './kv-store-path.js'

let storePath = getDefaultKvStorePath()
let database: DatabaseSync | null = null

const INTERNAL_KEY_PREFIXES = [
  '__chess-state:',
  '__quiz-generation:',
  '__quiz-state:',
  'command-input:',
  'constrained-command:',
  'env:',
  'gpt-ctx:',
  'gpt-mcp-servers',
  'gpt-settings:',
  'gpt-session:',
  'gpt-session-activity:',
  'gpt-session-selected:',
  'gpt-session-system-prompt:',
  'gpt-sessions:',
  'gpt-web-sessions:',
  'global-system-prompt',
  'message-input:',
  'message-render-',
  'message-store-',
  'poll:',
  'pub-content:',
  'web-oidc-settings',
  'web-session-secret',
  'web-rate:'
]

export function isInternalStoredKey(key: string): boolean {
  return INTERNAL_KEY_PREFIXES.some((prefix) => key.startsWith(prefix))
}

function getDatabase(): DatabaseSync {
  if (database) return database

  database = new DatabaseSync(storePath, { timeout: 5_000 })
  chmodSync(storePath, 0o600)
  database.exec(
    'CREATE TABLE IF NOT EXISTS kv_store (key TEXT PRIMARY KEY NOT NULL, value TEXT NOT NULL) STRICT'
  )
  return database
}

export function setStoredValue(key: string, value: string): void {
  getDatabase()
    .prepare(
      'INSERT INTO kv_store (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
    )
    .run(key, value)
}

export function getStoredValue(key: string): string | undefined {
  const row = getDatabase().prepare('SELECT value FROM kv_store WHERE key = ?').get(key) as
    | { value: string }
    | undefined
  return row?.value
}

export function getOrCreateStoredValue(key: string, value: string): string {
  const database = getDatabase()
  database
    .prepare('INSERT INTO kv_store (key, value) VALUES (?, ?) ON CONFLICT(key) DO NOTHING')
    .run(key, value)
  const stored = database.prepare('SELECT value FROM kv_store WHERE key = ?').get(key) as {
    value: string
  }
  return stored.value
}

export function hasStoredValue(key: string): boolean {
  const row = getDatabase().prepare('SELECT 1 AS present FROM kv_store WHERE key = ?').get(key) as
    | { present: number }
    | undefined
  return row?.present === 1
}

export function deleteStoredValue(key: string): void {
  getDatabase().prepare('DELETE FROM kv_store WHERE key = ?').run(key)
}

function withImmediateTransaction<T>(operation: (database: DatabaseSync) => T): T {
  const database = getDatabase()
  database.exec('BEGIN IMMEDIATE')
  try {
    const result = operation(database)
    database.exec('COMMIT')
    return result
  } catch (error) {
    database.exec('ROLLBACK')
    throw error
  }
}

export function consumeStoredRateLimit(
  key: string,
  limit: number,
  windowMs: number,
  now = Date.now()
): boolean {
  return withImmediateTransaction((database) => {
    const row = database.prepare('SELECT value FROM kv_store WHERE key = ?').get(key) as
      | { value: string }
      | undefined
    let windowStart = now
    let count = 0
    if (row) {
      try {
        const parsed = JSON.parse(row.value) as { windowStart?: unknown; count?: unknown }
        if (
          typeof parsed.windowStart === 'number' &&
          Number.isFinite(parsed.windowStart) &&
          parsed.windowStart <= now &&
          now - parsed.windowStart < windowMs &&
          typeof parsed.count === 'number' &&
          Number.isInteger(parsed.count) &&
          parsed.count >= 0
        ) {
          windowStart = parsed.windowStart
          count = parsed.count
        }
      } catch {
        // Invalid internal state starts a fresh rate-limit window.
      }
    }
    if (count >= limit) return false

    database
      .prepare(
        'INSERT INTO kv_store (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
      )
      .run(key, JSON.stringify({ windowStart, count: count + 1 }))
    return true
  })
}

export function tryAcquireStoredLease(
  key: string,
  owner: string,
  ttlMs: number,
  now = Date.now()
): boolean {
  return withImmediateTransaction((database) => {
    const row = database.prepare('SELECT value FROM kv_store WHERE key = ?').get(key) as
      | { value: string }
      | undefined
    if (row) {
      try {
        const parsed = JSON.parse(row.value) as { expiresAt?: unknown }
        if (typeof parsed.expiresAt === 'number' && parsed.expiresAt > now) return false
      } catch {
        // Invalid or expired internal leases can be replaced.
      }
    }

    database
      .prepare(
        'INSERT INTO kv_store (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
      )
      .run(key, JSON.stringify({ owner, expiresAt: now + ttlMs }))
    return true
  })
}

export function releaseStoredLease(key: string, owner: string): void {
  withImmediateTransaction((database) => {
    const row = database.prepare('SELECT value FROM kv_store WHERE key = ?').get(key) as
      | { value: string }
      | undefined
    if (!row) return
    try {
      const parsed = JSON.parse(row.value) as { owner?: unknown }
      if (parsed.owner === owner) {
        database.prepare('DELETE FROM kv_store WHERE key = ?').run(key)
      }
    } catch {
      database.prepare('DELETE FROM kv_store WHERE key = ?').run(key)
    }
  })
}

export function listStoredKeys(): string[] {
  const rows = getDatabase().prepare('SELECT key FROM kv_store ORDER BY key').all() as Array<{
    key: string
  }>
  return rows.map((row) => row.key)
}

export function clearStoredValues(): void {
  getDatabase().exec('DELETE FROM kv_store')
}

export function resetStoredValueConnection(): void {
  database?.close()
  database = null
}

export function setStoredValuePathForTests(filePath: string): void {
  resetStoredValueConnection()
  mkdirSync(dirname(filePath), { recursive: true })
  storePath = filePath
}
