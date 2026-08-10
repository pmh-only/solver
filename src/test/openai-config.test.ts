import { beforeEach, describe, expect, it } from 'vitest'
import { join } from 'node:path'
import { getStoredValue, isInternalStoredKey } from '../helpers/kv-store.js'
import { isolateStoredValues } from '../helpers/kv-store-test.js'
import {
  DEFAULT_OPENAI_ENDPOINT,
  loadOpenAIEndpoint,
  loadOpenAIEndpointSetting,
  openAIEndpointUrl,
  resetOpenAIEndpoint,
  updateOpenAIEndpoint
} from '../openai-config.js'

const storePath = join(process.cwd(), '.tmp', 'openai-config.test.sqlite')

beforeEach(() => isolateStoredValues(storePath))

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
})
