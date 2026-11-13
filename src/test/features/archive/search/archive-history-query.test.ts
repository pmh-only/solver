import { DuckDBInstance, type DuckDBConnection } from '@duckdb/node-api'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { compileArchiveHistorySql } from '../../../../features/archive/search/history-query.js'

let instance: DuckDBInstance
let connection: DuckDBConnection
beforeEach(async () => {
  instance = await DuckDBInstance.create(':memory:', { enable_external_access: 'false' })
  connection = await instance.connect()
})
afterEach(() => {
  connection.closeSync()
  instance.closeSync()
})
describe('allowlisted archive SQL compiler', () => {
  it('compiles natural search filters into server-owned parameterized SQL', async () => {
    const result = await compileArchiveHistorySql(connection, {
      sql: "SELECT message_id FROM messages WHERE (content ILIKE '%피자%' OR contains(lower(content), 'pizza')) AND author_id IN ('555555555555555555','666666666666666666') AND created_at BETWEEN '2026-01-01' AND '2026-12-31' ORDER BY created_at ASC LIMIT 5"
    })
    expect(result.predicate).toContain('"content" ILIKE ?')
    expect(result.predicate).toContain('contains(lower("content"),?)')
    expect(result.params).toEqual([
      '%피자%',
      'pizza',
      '555555555555555555',
      '666666666666666666',
      '2026-01-01',
      '2026-12-31'
    ])
    expect(result.order).toBe('"created_at" ASC')
    expect(result.limit).toBe(5)
  })
  it('keeps injection-looking string contents as bound values and clamps output', async () => {
    const result = await compileArchiveHistorySql(connection, {
      sql: "SELECT message_id FROM messages WHERE content = 'x''; DROP TABLE messages; --' LIMIT 100000"
    })
    expect(result.predicate).toBe('("content" = ?)')
    expect(result.params).toEqual(["x'; DROP TABLE messages; --"])
    expect(result.limit).toBe(12)
  })
  it.each([
    ['COUNT(*)', 'messages'],
    ['COUNT(*) AS total', 'messages'],
    ['COUNT(message_id)', 'messages'],
    ['COUNT(DISTINCT message_id)', 'messages'],
    ['COUNT(DISTINCT author_id) AS people', 'authors']
  ])('compiles only allowlisted counts: %s', async (projection, aggregate) => {
    const result = await compileArchiveHistorySql(connection, {
      sql: `SELECT ${projection} FROM messages WHERE content ILIKE '%피자%' AND created_at >= '2026-10-01' AND author_id='555555555555555555'`
    })
    expect(result.aggregate).toBe(aggregate)
    expect(result.params).toEqual(['%피자%', '2026-10-01', '555555555555555555'])
    expect(result.predicate).toContain('"content" ILIKE ?')
  })
  it.each([
    'DELETE FROM messages',
    'SELECT message_id FROM messages; SELECT 1',
    'SELECT * FROM messages',
    'SELECT content AS message_id FROM messages',
    'SELECT message_id FROM archive_state',
    'SELECT message_id FROM main.messages',
    'SELECT message_id FROM messages m',
    'SELECT message_id FROM messages UNION SELECT message_id FROM messages',
    'WITH hidden AS (SELECT * FROM messages) SELECT message_id FROM hidden',
    'SELECT message_id FROM messages WHERE EXISTS (SELECT 1 FROM message_events)',
    "SELECT message_id FROM read_text('/etc/passwd')",
    "SELECT message_id FROM messages WHERE content = getenv('SECRET')",
    'SELECT message_id FROM messages WHERE raw_json IS NOT NULL',
    'SELECT message_id FROM messages CROSS JOIN range(1000000000000)',
    'SELECT message_id FROM messages ORDER BY random()',
    'SELECT message_id FROM messages GROUP BY message_id',
    'SELECT message_id FROM messages GROUP BY ALL',
    "SELECT message_id FROM messages WHERE constructor(content, 'x')",
    'SELECT DISTINCT message_id FROM messages',
    'SELECT message_id FROM messages LIMIT -1',
    'SELECT message_id FROM messages LIMIT 10 OFFSET 5',
    'SELECT message_id FROM messages WHERE content = $secret',
    'SELECT SUM(attachments_count) FROM messages',
    'SELECT COUNT(content) FROM messages',
    'SELECT COUNT(DISTINCT content) FROM messages',
    'SELECT COUNT(author_id) FROM messages',
    'SELECT COUNT(*) FILTER (WHERE author_bot) FROM messages',
    'SELECT COUNT(*) FROM messages GROUP BY author_id',
    'SELECT COUNT(*) FROM messages HAVING COUNT(*) > 0',
    'SELECT COUNT(*) FROM messages ORDER BY created_at DESC',
    'SELECT COUNT(*) OVER () FROM messages',
    'SELECT COUNT(*), content FROM messages',
    'SELECT COUNT(*) FROM messages WHERE COUNT(*) > 0',
    "SELECT COUNT(*) FROM read_text('/etc/passwd')"
  ])('rejects unsupported SQL rather than executing it: %s', async (sql) => {
    await expect(compileArchiveHistorySql(connection, { sql })).rejects.toThrow()
  })
  it('bounds SQL length and expression depth', async () => {
    await expect(compileArchiveHistorySql(connection, { sql: 'x'.repeat(4001) })).rejects.toThrow()
    await expect(
      compileArchiveHistorySql(connection, {
        sql: `SELECT message_id FROM messages WHERE ${'NOT ('.repeat(20)}author_bot${')'.repeat(20)}`
      })
    ).rejects.toThrow()
  })
  it('supports boolean author filters without losing snowflake precision', async () => {
    const result = await compileArchiveHistorySql(connection, {
      sql: "SELECT message_id FROM messages WHERE author_bot = false AND author_id='555555555555555555'"
    })
    expect(result.params).toEqual([false, '555555555555555555'])
    await expect(
      compileArchiveHistorySql(connection, {
        sql: 'SELECT message_id FROM messages WHERE author_id=555555555555555555'
      })
    ).rejects.toThrow()
  })
})
