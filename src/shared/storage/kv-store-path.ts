import { mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'

function isTestRuntime(): boolean {
  return process.env.VITEST === 'true' || process.env.NODE_ENV === 'test'
}

function ensureParentDirectory(filePath: string): string {
  mkdirSync(dirname(filePath), { recursive: true })
  return filePath
}

export function getDefaultKvStorePath(): string {
  const configured = process.env.KV_STORE_PATH?.trim()

  if (configured) return ensureParentDirectory(configured)

  if (isTestRuntime()) {
    const worker = process.env.VITEST_POOL_ID ?? '0'
    return ensureParentDirectory(join(process.cwd(), '.tmp', `kv-store-test-${worker}.sqlite`))
  }

  return ensureParentDirectory(join(process.cwd(), 'data', 'kv.sqlite'))
}
