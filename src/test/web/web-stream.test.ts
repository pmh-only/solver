import { runInNewContext } from 'node:vm'
import { describe, expect, it, vi } from 'vitest'
import { WEB_STREAM_JS } from '../../web/ui.js'

const readUpdates = runInNewContext(`${WEB_STREAM_JS};readUpdates`, { TextDecoder }) as (
  response: { body: ReadableStream<Uint8Array> },
  onUpdate: (value: unknown) => unknown,
  onChunk?: (value: Uint8Array) => void
) => Promise<void>

function stream(chunks: Uint8Array[]) {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk)
      controller.close()
    }
  })
}

describe('web update stream', () => {
  it('decodes split UTF-8 and JSON records, blank lines and an unterminated final record', async () => {
    const bytes = new TextEncoder().encode('\n{"text":"안녕 🌍"}\n\n{"done":true}')
    const body = stream(Array.from(bytes, (byte) => Uint8Array.of(byte)))
    const updates: unknown[] = []
    const onChunk = vi.fn()
    await readUpdates({ body }, (value) => updates.push(value), onChunk)
    expect(updates).toEqual([{ text: '안녕 🌍' }, { done: true }])
    expect(onChunk).toHaveBeenCalledTimes(bytes.length)
    expect(body.locked).toBe(false)
  })

  it('awaits consumers in order and releases the reader when a consumer fails', async () => {
    const body = stream([new TextEncoder().encode('{"n":1}\n{"n":2}\n')])
    const consume = vi.fn(async () => {
      throw new Error('render failed')
    })
    await expect(readUpdates({ body }, consume)).rejects.toThrow('render failed')
    expect(consume).toHaveBeenCalledOnce()
    expect(body.locked).toBe(false)
  })

  it('rejects malformed final records and releases the reader', async () => {
    const body = stream([new TextEncoder().encode('{"incomplete":')])
    await expect(readUpdates({ body }, () => {})).rejects.toThrow()
    expect(body.locked).toBe(false)
  })
})
