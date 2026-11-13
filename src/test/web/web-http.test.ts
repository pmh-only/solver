import { EventEmitter } from 'node:events'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { Readable } from 'node:stream'
import { describe, expect, it, vi } from 'vitest'
import { readJson, streamJson } from '../../web/http.js'

function response() {
  const emitter = new EventEmitter()
  const output = Object.assign(emitter, {
    destroyed: false,
    writableEnded: false,
    writeHead: vi.fn(),
    write: vi.fn(),
    end: vi.fn()
  })
  output.end.mockImplementation(() => {
    output.writableEnded = true
  })
  return output
}

describe('HTTP transport helpers', () => {
  it.each(['abort', 'continue'] as const)(
    'applies the %s disconnect policy and removes its listener',
    async (policy) => {
      const output = response()
      await streamJson(output as unknown as ServerResponse, policy, async (write, signal) => {
        write({ started: true })
        output.destroyed = true
        output.emit('close')
        expect(signal.aborted).toBe(policy === 'abort')
        write({ disconnected: true })
      })
      expect(output.write).toHaveBeenCalledExactlyOnceWith('{"started":true}\n')
      expect(output.listenerCount('close')).toBe(0)
      expect(output.end).toHaveBeenCalledOnce()
      expect(output.writeHead).toHaveBeenCalledWith(
        200,
        expect.objectContaining({
          'Content-Type': 'application/x-ndjson; charset=utf-8',
          'X-Content-Type-Options': 'nosniff'
        })
      )
    }
  )

  it('ends failed streams with a redacted error', async () => {
    const output = response()
    await streamJson(output as unknown as ServerResponse, 'abort', async () => {
      throw new Error('private upstream detail')
    })
    expect(output.write).toHaveBeenCalledExactlyOnceWith('{"error":"Request failed"}\n')
    expect(output.listenerCount('close')).toBe(0)
    expect(output.end).toHaveBeenCalledOnce()
  })

  it('enforces the JSON body size and content type before returning data', async () => {
    const request = (body: string, contentType: string) =>
      Object.assign(Readable.from([body]), {
        headers: { 'content-type': contentType }
      }) as unknown as IncomingMessage
    await expect(
      readJson(request('"' + 'x'.repeat(64 * 1024) + '"', 'application/json'))
    ).rejects.toThrow('too large')
    await expect(readJson(request('{}', 'text/plain'))).rejects.toThrow('Content-Type')
    await expect(readJson(request('{"value":1}', 'application/json'))).resolves.toEqual({
      value: 1
    })
  })
})
