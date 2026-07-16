import { DatabaseSync } from 'node:sqlite'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

import { getDefaultKvStorePath } from './kv-store-path.js'

let storePath = getDefaultKvStorePath()
let database: DatabaseSync | null = null

const INTERNAL_KEY_PREFIXES = [
  '__chess-state:',
  '__quiz-state:',
  'command-input:',
  'constrained-command:',
  'gpt-ctx:',
  'message-input:',
  'message-render-',
  'message-store-',
  'poll:',
  'pub-content:'
]

export function isInternalStoredKey(key: string): boolean {
  return INTERNAL_KEY_PREFIXES.some((prefix) => key.startsWith(prefix))
}

function getDatabase(): DatabaseSync {
  if (database) return database

  database = new DatabaseSync(storePath)
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

export function hasStoredValue(key: string): boolean {
  const row = getDatabase().prepare('SELECT 1 AS present FROM kv_store WHERE key = ?').get(key) as
    | { present: number }
    | undefined
  return row?.present === 1
}

export function deleteStoredValue(key: string): void {
  getDatabase().prepare('DELETE FROM kv_store WHERE key = ?').run(key)
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
