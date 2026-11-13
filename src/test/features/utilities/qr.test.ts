import { join } from 'node:path'
import { loadImage } from '@napi-rs/canvas'
import { InteractionResponseType, MessageFlags } from 'discord.js'
import QRCode from 'qrcode'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { qr } from '../../../features/utilities/catalog.js'
import { clearStoredValues } from '../../../shared/storage/kv-store.js'
import { isolateStoredValues } from '../../support/kv-store.js'
import {
  buttonJSON,
  commandJSON,
  dispatch,
  getCallback,
  getEdit,
  makeSubcommands,
  type RestCall
} from '../../support/e2e.js'

const subs = makeSubcommands(qr)
function file(calls: RestCall[]) {
  const edit = calls.find((call) => call.method === 'PATCH')
  expect(edit?.files).toHaveLength(1)
  return edit!.files[0] as { name: string; data: Buffer }
}

beforeEach(() => {
  isolateStoredValues(join(process.cwd(), '.tmp', 'qr.test.sqlite'))
  clearStoredValues()
})
afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('QR image command', () => {
  it('generates and attaches a local 512px PNG with no external requests', async () => {
    const fetch = vi.fn()
    vi.stubGlobal('fetch', fetch)
    const generate = vi.spyOn(QRCode, 'toBuffer')
    const calls = await dispatch(commandJSON('qr 안녕하세요 https://example.com/private'), subs)
    const callback = getCallback(calls) as { type: number; data: { flags: number } }
    expect(callback.type).toBe(InteractionResponseType.DeferredChannelMessageWithSource)
    expect(callback.data.flags & MessageFlags.Ephemeral).toBeTruthy()
    expect(generate).toHaveBeenCalledWith(
      '안녕하세요 https://example.com/private',
      expect.any(Object)
    )
    const attachment = file(calls)
    expect(attachment.name).toBe('qr.png')
    expect(attachment.data.subarray(0, 8)).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
    const image = await loadImage(attachment.data)
    expect([image.width, image.height]).toEqual([512, 512])
    expect(JSON.stringify(getEdit(calls))).toContain('attachment://qr.png')
    expect(fetch).not.toHaveBeenCalled()
  })

  it.each(['--pub', '-p'])(
    'publishes only the image without raw text or a QR service URL (%s)',
    async (flag) => {
      const calls = await dispatch(commandJSON(`qr https://example.com/secret-token ${flag}`), subs)
      const callback = getCallback(calls) as { data: { flags?: number } }
      expect((callback.data.flags ?? 0) & MessageFlags.Ephemeral).toBeFalsy()
      const rendered = JSON.stringify(getEdit(calls))
      expect(rendered).toContain('attachment://qr.png')
      expect(rendered).not.toContain('secret-token')
      expect(rendered).not.toContain('qrserver')
      expect(rendered).not.toContain('custom_id')
      file(calls)
    }
  )

  it('keeps retry working without exposing the input in message text', async () => {
    const generate = vi.spyOn(QRCode, 'toBuffer')
    const calls = await dispatch(commandJSON('qr hidden-original'), subs)
    const edit = getEdit(calls) as { components: unknown[] }
    expect(JSON.stringify(edit)).not.toContain('hidden-original')
    const retried = await dispatch(buttonJSON(edit.components, 'retry'), subs)
    expect(generate).toHaveBeenNthCalledWith(2, 'hidden-original', expect.any(Object))
    file(retried)
    expect(JSON.stringify(getEdit(retried))).not.toContain('hidden-original')
  })

  it('copies the attachment on Publish without revealing the input', async () => {
    const calls = await dispatch(commandJSON('qr private-publish-input'), subs)
    const edit = getEdit(calls) as { components: unknown[] }
    const image = file(calls).data
    const fetch = vi.fn(async () => new Response(new Uint8Array(image), { status: 200 }))
    vi.stubGlobal('fetch', fetch)
    const published = await dispatch(buttonJSON(edit.components, 'pub'), subs)
    expect(fetch).toHaveBeenCalledOnce()
    expect(file(published).data).toEqual(image)
    const rendered = JSON.stringify(getEdit(published))
    expect(rendered).toContain('attachment://qr.png')
    expect(rendered).not.toContain('private-publish-input')
    expect(rendered).not.toContain('custom_id')
  })

  it.each(['qr', `qr ${'x'.repeat(2001)} --pub`, `qr ${'한'.repeat(667)} --pub`])(
    'rejects missing or oversized input without leaking it',
    async (input) => {
      const generate = vi.spyOn(QRCode, 'toBuffer')
      const calls = await dispatch(commandJSON(input), subs)
      const rendered = JSON.stringify(getCallback(calls))
      expect(rendered).toMatch(/no text|2000 UTF-8 bytes/)
      expect(rendered).not.toContain('x'.repeat(100))
      expect(rendered).not.toContain('한'.repeat(100))
      expect(generate).not.toHaveBeenCalled()
    }
  )

  it('handles generation failures without echoing raw errors or input', async () => {
    vi.spyOn(QRCode, 'toBuffer').mockRejectedValueOnce(new Error('secret-input'))
    const calls = await dispatch(commandJSON('qr secret-input --pub'), subs)
    const rendered = JSON.stringify(getEdit(calls))
    expect(rendered).toContain('could not generate QR image')
    expect(rendered).not.toContain('secret-input')
    expect(calls.find((call) => call.method === 'PATCH')?.files).toHaveLength(0)
  })
})
