import { join } from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import { clearStoredValues, isInternalStoredKey, setStoredValue } from '../helpers/kv-store.js'
import { isolateStoredValues } from '../helpers/kv-store-test.js'
import { loadDiscordSessionMode, setDiscordSessionMode } from '../agent/session-privacy.js'
import { loadGptContext } from '../agent/interaction-context.js'

beforeEach(() => {
  isolateStoredValues(join(process.cwd(), '.tmp', 'session-privacy.test.sqlite'))
  clearStoredValues()
})
describe('Discord session privacy settings', () => {
  it.each([{ pub: 'false' }, { userId: null }, { sessionName: null }])(
    'expires interaction contexts with corrupt privacy metadata: %j',
    (invalid) => {
      setStoredValue(
        'gpt-ctx:corrupt',
        JSON.stringify({
          displayPrompt: 'private',
          expiresAt: Date.now() + 10000,
          components: [],
          pub: false,
          userId: 'user',
          sessionName: 'session',
          ...invalid
        })
      )
      expect(loadGptContext('corrupt')).toBeNull()
    }
  )
  it('defaults to public and persists a stable, opaque private history namespace', () => {
    expect(loadDiscordSessionMode('user', 'work').private).toBe(false)
    const privateMode = setDiscordSessionMode('user', 'work', true)
    expect(privateMode.privateSession).toMatch(/^__feature:private:[a-f0-9]{32}$/)
    expect(loadDiscordSessionMode('user', 'work')).toEqual(privateMode)
    setDiscordSessionMode('user', 'work', false)
    expect(setDiscordSessionMode('user', 'work', true).privateSession).toBe(
      privateMode.privateSession
    )
  })
  it('isolates visibility and private histories by user and logical session', () => {
    const a = setDiscordSessionMode('a', 'work', true)
    expect(loadDiscordSessionMode('b', 'work').private).toBe(false)
    expect(loadDiscordSessionMode('a', 'personal').private).toBe(false)
    const b = setDiscordSessionMode('b', 'work', true)
    expect(a.privateSession).not.toBe(b.privateSession)
  })
  it('fails private on corrupt settings and keeps visibility keys out of /c list', () => {
    setStoredValue('gpt-session-privacy:user:work', '{broken')
    const mode = loadDiscordSessionMode('user', 'work')
    expect(mode.private).toBe(true)
    expect(loadDiscordSessionMode('user', 'work')).toEqual(mode)
    expect(isInternalStoredKey('gpt-session-privacy:user:work')).toBe(true)
    expect(setDiscordSessionMode('user', 'work', false).private).toBe(false)
  })
})
