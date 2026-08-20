import { afterEach, describe, expect, it } from 'vitest'
import { rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { getAgentMemoryPath } from '../helpers/agent-memory-path.js'

const testDirectory = join(process.cwd(), '.tmp', 'agent-memory-path-test')
const previousKvStorePath = process.env.KV_STORE_PATH

afterEach(async () => {
  if (previousKvStorePath === undefined) delete process.env.KV_STORE_PATH
  else process.env.KV_STORE_PATH = previousKvStorePath
  await rm(testDirectory, { recursive: true, force: true })
})

describe('agent memory path', () => {
  it('stores the graph beside the configured persistent KV store', async () => {
    process.env.KV_STORE_PATH = join(testDirectory, 'kv.sqlite')

    expect(getAgentMemoryPath()).toBe(join(testDirectory, '.agent-memory.jsonl'))
    expect((await stat(testDirectory)).isDirectory()).toBe(true)
  })
})
