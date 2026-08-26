import { InteractionResponseType, MessageFlags } from 'discord.js'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { subcommand as down } from '../commands/down.js'
import { DOWN_MAX_BYTES, downloadUrl } from '../commands/down-runtime.js'
import { commandJSON, dispatch, getCallback, getEdit, makeSubcommands } from './e2e.js'
import * as downRuntime from '../commands/down-runtime.js'

const subs = makeSubcommands(down)
const publicAddress = [{ address: '93.184.216.34', family: 4 }]

function dependencies(fetchMock: typeof fetch, addresses = publicAddress, timeoutMs?: number) {
  return {
    fetch: fetchMock,
    lookup: vi.fn(async () => addresses),
    timeoutMs
  }
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('down runtime', () => {
  it('downloads a public URL and uses its response filename', async () => {
    const fetchMock = vi.fn(async () =>
      Promise.resolve(
        new Response('file data', {
          status: 200,
          headers: {
            'content-disposition': 'attachment; filename="report final.txt"',
            'content-type': 'text/plain'
          }
        })
      )
    ) as unknown as typeof fetch

    const result = await downloadUrl(
      'https://example.com/download?token=secret',
      dependencies(fetchMock)
    )

    expect(result.fileName).toBe('report final.txt')
    expect(result.data.toString()).toBe('file data')
    expect(result.contentType).toBe('text/plain')
    expect(fetchMock).toHaveBeenCalledOnce()
  })

  it('rejects private addresses before fetching', async () => {
    const fetchMock = vi.fn() as unknown as typeof fetch

    await expect(
      downloadUrl(
        'http://internal.example/file',
        dependencies(fetchMock, [{ address: '127.0.0.1', family: 4 }])
      )
    ).rejects.toThrow('private URLs are not allowed')
    await expect(downloadUrl('http://[::1]/file', dependencies(fetchMock))).rejects.toThrow(
      'private URLs are not allowed'
    )
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('validates redirect destinations and blocks metadata addresses', async () => {
    const fetchMock = vi.fn(async () =>
      Promise.resolve(
        new Response(null, {
          status: 302,
          headers: { location: 'http://169.254.169.254/latest/meta-data' }
        })
      )
    ) as unknown as typeof fetch

    await expect(downloadUrl('https://example.com/file', dependencies(fetchMock))).rejects.toThrow(
      'private URLs are not allowed'
    )
    expect(fetchMock).toHaveBeenCalledOnce()
  })

  it('stops before reading a declared file larger than 10 MB', async () => {
    const fetchMock = vi.fn(async () =>
      Promise.resolve(
        new Response('ignored', {
          headers: { 'content-length': String(DOWN_MAX_BYTES + 1) }
        })
      )
    ) as unknown as typeof fetch

    await expect(
      downloadUrl('https://example.com/large.bin', dependencies(fetchMock))
    ).rejects.toThrow('file is larger than 10 MB')
  })

  it('stops a streamed file that exceeds 10 MB without a declared length', async () => {
    const oversized = new Uint8Array(DOWN_MAX_BYTES + 1)
    const fetchMock = vi.fn(async () =>
      Promise.resolve(new Response(oversized))
    ) as unknown as typeof fetch

    await expect(
      downloadUrl('https://example.com/large.bin', dependencies(fetchMock))
    ).rejects.toThrow('file is larger than 10 MB')
  })

  it('rejects unsupported protocols and URL credentials', async () => {
    await expect(downloadUrl('file:///etc/passwd')).rejects.toThrow('only HTTP and HTTPS')
    await expect(downloadUrl('https://user:pass@example.com/file')).rejects.toThrow(
      'URLs with credentials'
    )
  })

  it('aborts downloads that exceed the request timeout', async () => {
    const fetchMock = vi.fn(
      async (_input: URL | RequestInfo, init?: RequestInit) =>
        await new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true })
        })
    ) as unknown as typeof fetch

    await expect(
      downloadUrl('https://example.com/slow.bin', dependencies(fetchMock, publicAddress, 5))
    ).rejects.toThrow(/timeout/i)
  })
})

describe('down command', () => {
  it('shows usage when the URL is missing', async () => {
    const calls = await dispatch(commandJSON('down'), subs)
    const body = getCallback(calls) as { type: number }

    expect(body.type).toBe(InteractionResponseType.ChannelMessageWithSource)
    expect(JSON.stringify(body)).toContain('provide one URL')
  })

  it('downloads and uploads the file ephemerally without exposing the query', async () => {
    vi.spyOn(downRuntime, 'downloadUrl').mockResolvedValue({
      data: Buffer.from('downloaded'),
      fileName: 'result.bin',
      finalUrl: 'https://example.com/result.bin?token=secret',
      contentType: 'application/octet-stream'
    })

    const calls = await dispatch(commandJSON('down https://example.com/file?token=secret'), subs)
    const defer = getCallback(calls) as { type: number; data: { flags: number } }
    const edit = getEdit(calls)
    const patch = calls.find((call) => call.method === 'PATCH')

    expect(defer.type).toBe(InteractionResponseType.DeferredChannelMessageWithSource)
    expect(defer.data.flags & MessageFlags.Ephemeral).toBeTruthy()
    expect(JSON.stringify(edit)).toContain('attachment://result.bin')
    expect(JSON.stringify(edit)).not.toContain('token=secret')
    expect(patch?.files).toHaveLength(1)
  })

  it('supports public downloads with --pub', async () => {
    vi.spyOn(downRuntime, 'downloadUrl').mockResolvedValue({
      data: Buffer.from('downloaded'),
      fileName: 'result.bin',
      finalUrl: 'https://example.com/result.bin',
      contentType: 'application/octet-stream'
    })

    const calls = await dispatch(commandJSON('down https://example.com/file --pub'), subs)
    const defer = getCallback(calls) as { data: { flags?: number } }

    expect((defer.data.flags ?? 0) & MessageFlags.Ephemeral).toBeFalsy()
  })
})
