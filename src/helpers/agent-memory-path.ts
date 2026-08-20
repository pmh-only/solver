import { dirname, resolve } from 'node:path'
import { getDefaultKvStorePath } from './kv-store-path.js'

export function getAgentMemoryPath(): string {
  return resolve(dirname(getDefaultKvStorePath()), '.agent-memory.jsonl')
}
