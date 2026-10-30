import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { interpretArchiveSearch } from '../archive-search-ai.js'
import { manageCommunitySettings } from '../community-settings.js'
import { clearStoredValues } from '../helpers/kv-store.js'
import { isolateStoredValues } from '../helpers/kv-store-test.js'

const { create, construct } = vi.hoisted(() => ({ create: vi.fn(), construct: vi.fn() }))
vi.mock('openai', () => ({
  default: class {
    constructor(options: unknown) {
      construct(options)
    }
    responses = { create }
  }
}))
vi.mock('../openai-config.js', () => ({
  loadOpenAIApiKey: () => 'test-token',
  loadOpenAIEndpoint: () => 'https://api.example.com/v1'
}))
beforeEach(() => {
  isolateStoredValues(join(process.cwd(), '.tmp', 'archive-search-ai.test.sqlite'))
  clearStoredValues()
  vi.resetAllMocks()
  create.mockResolvedValue({
    status: 'completed',
    output_text: JSON.stringify({ keyword: '털', scope: 'content' })
  })
})
afterEach(() => clearStoredValues())

it('uses bounded structured AI interpretation for natural requests without quotes', async () => {
  const input = '본문에 털이 들어가는 글 찾아줘'
  expect(await interpretArchiveSearch(input)).toEqual({ keyword: '털', scope: 'content' })
  expect(create).toHaveBeenCalledWith(
    expect.objectContaining({
      input,
      store: false,
      max_output_tokens: 512,
      text: { format: expect.objectContaining({ type: 'json_schema', strict: true }) }
    }),
    { signal: expect.any(AbortSignal) }
  )
  expect(construct).toHaveBeenCalledWith(expect.objectContaining({ maxRetries: 0, timeout: 15000 }))
})
it('uses the model configured through /a', async () => {
  manageCommunitySettings({
    action: 'update',
    settings: { discordArchive: { searchModel: 'custom-model' } }
  })
  await interpretArchiveSearch('털 들어간 글')
  expect(create.mock.calls[0]![0].model).toBe('custom-model')
})
it('accepts an ambiguous intent as a clarification rather than an invented query', async () => {
  create.mockResolvedValue({ status: 'completed', output_text: '{"keyword":null,"scope":"all"}' })
  expect(await interpretArchiveSearch('찾아줘')).toBeNull()
})
it.each([
  'broken',
  '{"keyword":"털","scope":"private"}',
  JSON.stringify({ keyword: 'x'.repeat(201), scope: 'all' }),
  '{"keyword":"털","scope":"all","sql":"SELECT *"}',
  '{"keyword":"","scope":"all"}'
])('rejects malformed or unauthorized model output %s', async (output_text) => {
  create.mockResolvedValue({ status: 'completed', output_text })
  await expect(interpretArchiveSearch('찾아줘')).rejects.toThrow()
})
it('rejects incomplete responses and propagates API failures', async () => {
  create.mockResolvedValueOnce({ status: 'incomplete', output_text: '{}' })
  await expect(interpretArchiveSearch('털 찾아줘')).rejects.toThrow('did not complete')
  create.mockRejectedValueOnce(new Error('timeout'))
  await expect(interpretArchiveSearch('털 찾아줘')).rejects.toThrow('timeout')
})
it('does not spend tokens for empty or oversized requests', async () => {
  expect(await interpretArchiveSearch(' ')).toBeNull()
  expect(await interpretArchiveSearch('x'.repeat(4001))).toBeNull()
  expect(create).not.toHaveBeenCalled()
})
