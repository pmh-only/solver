import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { join } from 'node:path'
import { getStoredValue, isInternalStoredKey } from '../helpers/kv-store.js'
import { isolateStoredValues } from '../helpers/kv-store-test.js'
import {
  DEFAULT_OPENAI_ENDPOINT,
  loadOpenAIEndpoint,
  loadOpenAIEndpointSetting,
  loadOpenAIApiKey,
  loadOpenAITokenSetting,
  openAIEndpointUrl,
  resetOpenAIEndpoint,
  resetOpenAIToken,
  updateOpenAIEndpoint,
  updateOpenAIToken
} from '../openai-config.js'

const storePath = join(process.cwd(), '.tmp', 'openai-config.test.sqlite')

beforeEach(() => {
  isolateStoredValues(storePath)
  delete process.env.OPENAI_API_KEY
  delete process.env.WEB_SESSION_SECRET
})

afterEach(() => {
  delete process.env.OPENAI_API_KEY
  delete process.env.WEB_SESSION_SECRET
})

describe('OpenAI endpoint configuration', () => {
  it('uses the official endpoint until a replacement is persisted', () => {
    expect(loadOpenAIEndpointSetting()).toEqual({
      endpoint: DEFAULT_OPENAI_ENDPOINT,
      isDefault: true,
      updatedAt: null,
      updatedBy: null
    })

    const saved = updateOpenAIEndpoint(
      { endpoint: 'https://inference.example.com/openai/v1/' },
      'admin-1'
    )

    expect(saved).toMatchObject({
      endpoint: 'https://inference.example.com/openai/v1',
      isDefault: false,
      updatedBy: 'admin-1'
    })
    expect(loadOpenAIEndpoint()).toBe('https://inference.example.com/openai/v1')
    expect(openAIEndpointUrl('/models')).toBe('https://inference.example.com/openai/v1/models')
    expect(getStoredValue('openai-endpoint')).toContain('inference.example.com')
    expect(isInternalStoredKey('openai-endpoint')).toBe(true)
  })

  it('rejects unsafe or malformed endpoint URLs', () => {
    expect(() => updateOpenAIEndpoint({ endpoint: 'ftp://example.com/v1' }, 'admin')).toThrow(
      'HTTP or HTTPS'
    )
    expect(() =>
      updateOpenAIEndpoint({ endpoint: 'https://user:pass@example.com/v1' }, 'admin')
    ).toThrow('credentials')
    expect(() =>
      updateOpenAIEndpoint({ endpoint: 'https://example.com/v1?token=secret' }, 'admin')
    ).toThrow('query string')
  })

  it('persists a reset to the official endpoint', () => {
    updateOpenAIEndpoint({ endpoint: 'http://localhost:8080/v1' }, 'admin-1')

    expect(resetOpenAIEndpoint('admin-2')).toMatchObject({
      endpoint: DEFAULT_OPENAI_ENDPOINT,
      isDefault: true,
      updatedBy: 'admin-2'
    })
  })

  it('encrypts a token override and never returns its value in public settings', () => {
    process.env.OPENAI_API_KEY = 'environment-token'

    const setting = updateOpenAIToken({ token: 'override-secret-token' }, 'admin-1')

    expect(setting).toMatchObject({
      hasOverride: true,
      hasEnvironmentToken: true,
      effectiveSource: 'override',
      updatedBy: 'admin-1'
    })
    expect(setting).not.toHaveProperty('token')
    expect(getStoredValue('openai-token')).not.toContain('override-secret-token')
    expect(loadOpenAIApiKey()).toBe('override-secret-token')
    expect(isInternalStoredKey('openai-token')).toBe(true)
  })

  it('falls back to the environment token after removing the override', () => {
    process.env.OPENAI_API_KEY = 'environment-token'
    expect(loadOpenAITokenSetting()).toMatchObject({
      hasOverride: false,
      effectiveSource: 'environment'
    })

    updateOpenAIToken({ token: 'override-token' }, 'admin')
    expect(resetOpenAIToken()).toMatchObject({
      hasOverride: false,
      hasEnvironmentToken: true,
      effectiveSource: 'environment'
    })
    expect(loadOpenAIApiKey()).toBe('environment-token')
  })
})
