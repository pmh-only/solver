import { beforeEach, describe, expect, it } from 'vitest'
import { deleteStoredValue, getStoredValue, isInternalStoredKey } from '../helpers/kv-store.js'
import {
  DEFAULT_SYSTEM_PROMPT,
  loadSystemPrompt,
  loadSystemPromptSetting,
  MAX_SYSTEM_PROMPT_LENGTH,
  resetSystemPrompt,
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
})
