import { beforeEach, describe, expect, it, vi } from 'vitest'
import { deleteStoredValue, getStoredValue, isInternalStoredKey } from '../helpers/kv-store.js'
import {
  DEFAULT_SYSTEM_PROMPT,
  loadEffectiveSystemPrompt,
  loadSessionSystemPromptSetting,
  loadSystemPrompt,
  loadSystemPromptSetting,
  MAX_SYSTEM_PROMPT_LENGTH,
  resetSystemPrompt,
  resetSessionSystemPrompt,
  updateSessionSystemPrompt,
  updateSystemPrompt
} from '../system-prompt.js'

describe('global system prompt', () => {
  beforeEach(() => deleteStoredValue('global-system-prompt'))

  it('uses the built-in default until an administrator stores a replacement', () => {
    expect(loadSystemPromptSetting()).toEqual({
      prompt: DEFAULT_SYSTEM_PROMPT,
      isDefault: true,
      updatedAt: null,
      updatedBy: null
    })

    const saved = updateSystemPrompt({ prompt: 'Answer like a careful investigator.' }, 'admin-1')

    expect(loadSystemPrompt()).toBe('Answer like a careful investigator.')
    expect(saved).toMatchObject({ isDefault: false, updatedBy: 'admin-1' })
    expect(saved.updatedAt).toEqual(expect.any(String))
    expect(getStoredValue('global-system-prompt')).not.toContain('null')
  })

  it('resets to the default while recording who made the change', () => {
    updateSystemPrompt({ prompt: 'Custom prompt' }, 'admin-1')

    expect(resetSystemPrompt('admin-2')).toMatchObject({
      prompt: DEFAULT_SYSTEM_PROMPT,
      isDefault: true,
      updatedBy: 'admin-2'
    })
    expect(loadSystemPrompt()).toBe(DEFAULT_SYSTEM_PROMPT)
  })

  it('rejects invalid prompt values and keeps the setting internal', () => {
    expect(() => updateSystemPrompt({ prompt: '' }, 'admin')).toThrow()
    expect(() =>
      updateSystemPrompt({ prompt: 'x'.repeat(MAX_SYSTEM_PROMPT_LENGTH + 1) }, 'admin')
    ).toThrow()
    expect(isInternalStoredKey('global-system-prompt')).toBe(true)
  })

  it('persists additional prompts in the single-user session namespace', () => {
    const saved = updateSessionSystemPrompt(
      'user:1',
      'project notes',
      { prompt: 'Use the project terminology.' },
      'user:1'
    )

    expect(saved).toMatchObject({ prompt: 'Use the project terminology.', isSet: true })
    expect(loadSessionSystemPromptSetting('user:1', 'project notes')).toEqual(saved)
    expect(loadSessionSystemPromptSetting('user:1', 'other')).toMatchObject({
      prompt: '',
      isSet: false
    })
    expect(isInternalStoredKey('gpt-session-system-prompt:project%20notes')).toBe(true)
  })

  it('combines the permanent global prompt with only the selected session prompt', () => {
    updateSystemPrompt({ prompt: 'Global instructions.' }, 'admin')
    updateSessionSystemPrompt('user-1', 'work', { prompt: 'Work-session instructions.' }, 'user-1')
    const now = new Date('2026-08-24T14:35:12.345Z')

    expect(loadEffectiveSystemPrompt('user-1', 'work', now)).toBe(
      'Global instructions.\n\nAdditional instructions for the current session:\nWork-session instructions.\n\nCurrent date and time: 2026-08-24T23:35:12.345+09:00 [Asia/Seoul].'
    )
    expect(loadEffectiveSystemPrompt('user-1', 'other', now)).toBe(
      'Global instructions.\n\nCurrent date and time: 2026-08-24T23:35:12.345+09:00 [Asia/Seoul].'
    )

    expect(resetSessionSystemPrompt('user-1', 'work')).toEqual({
      prompt: '',
      isSet: false,
      updatedAt: null,
      updatedBy: null
    })
    expect(loadEffectiveSystemPrompt('user-1', 'work', now)).toBe(
      'Global instructions.\n\nCurrent date and time: 2026-08-24T23:35:12.345+09:00 [Asia/Seoul].'
    )
  })

  it('computes the current date and time when each effective prompt is loaded', () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    try {
      vi.setSystemTime(new Date('2026-08-24T01:02:03.004Z'))
      expect(loadEffectiveSystemPrompt('user-1', 'work')).toContain(
        'Current date and time: 2026-08-24T10:02:03.004+09:00 [Asia/Seoul].'
      )

      vi.setSystemTime(new Date('2026-08-24T05:06:07.008Z'))
      expect(loadEffectiveSystemPrompt('user-1', 'work')).toContain(
        'Current date and time: 2026-08-24T14:06:07.008+09:00 [Asia/Seoul].'
      )
    } finally {
      vi.useRealTimers()
    }
  })
})
