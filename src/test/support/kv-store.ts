import { rmSync } from 'node:fs'

import {
  clearStoredValues,
  resetStoredValueConnection,
  setStoredValuePathForTests
} from '../../shared/storage/kv-store.js'

export function isolateStoredValues(filePath: string): void {
  rmSync(filePath, { force: true })
  setStoredValuePathForTests(filePath)
  clearStoredValues()
}

export function reopenStoredValuesForTests(): void {
  resetStoredValueConnection()
}
