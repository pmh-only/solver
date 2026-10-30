import { DatabaseSync } from 'node:sqlite'
import { chmodSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

/** Bounded process-crash-safe WAL outbox; avoid an fsync on the gateway event loop for every message. */
export class DiscordArchiveOutbox {
  private readonly database: DatabaseSync
  constructor(path: string) {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
    chmodSync(dirname(path), 0o700)
    this.database = new DatabaseSync(path)
    chmodSync(path, 0o600)
    this.database.exec(`PRAGMA journal_mode=WAL;
      PRAGMA synchronous=NORMAL;
      PRAGMA wal_autocheckpoint=100;
      PRAGMA journal_size_limit=1048576;
      PRAGMA max_page_count=8192;
      CREATE TABLE IF NOT EXISTS events(id TEXT PRIMARY KEY, channel_id TEXT NOT NULL, payload TEXT NOT NULL) STRICT;`)
  }
  list() {
    return this.database.prepare('SELECT id, channel_id, payload FROM events LIMIT 1001').all() as {
      id: string
      channel_id: string
      payload: string
    }[]
  }
  put(id: string, channelId: string, payload: string) {
    this.database
      .prepare('INSERT INTO events VALUES (?, ?, ?) ON CONFLICT(id) DO NOTHING')
      .run(id, channelId, payload)
  }
  delete(id: string) {
    this.database.prepare('DELETE FROM events WHERE id=?').run(id)
  }
  close() {
    this.database.close()
  }
}
