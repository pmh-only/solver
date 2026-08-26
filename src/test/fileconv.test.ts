import { createCanvas, loadImage } from '@napi-rs/canvas'
import { ComponentType, InteractionResponseType, MessageFlags } from 'discord.js'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  FILECONV_MODAL_PREFIX,
  FILECONV_FORMAT_ID,
  FILECONV_UPLOAD_ID,
  subcommand as fileconv
} from '../commands/fileconv.js'
import {
  convertedFileName,
  convertImage,
  convertMedia,
  downloadDiscordAttachment,
  parseFileconvFormat
} from '../commands/fileconv-runtime.js'
import {
  autocompleteJSON,
  commandJSON,
  dispatch,
  getCallback,
  getEdit,
  makeSubcommands,
  modalJSON,
  type RawInteraction
} from './e2e.js'

const subs = makeSubcommands(fileconv)
const attachmentUrl = 'https://cdn.discordapp.com/attachments/1/2/photo.png'

function pngBuffer() {
  const canvas = createCanvas(2, 2)
  const context = canvas.getContext('2d')
  context.fillStyle = '#ff0000'
  context.fillRect(0, 0, 2, 2)
  return canvas.toBuffer('image/png')
}

function wavBuffer() {
  const sampleCount = 800
  const buffer = Buffer.alloc(44 + sampleCount * 2)
  buffer.write('RIFF')
  buffer.writeUInt32LE(36 + sampleCount * 2, 4)
  buffer.write('WAVEfmt ', 8)
  buffer.writeUInt32LE(16, 16)
  buffer.writeUInt16LE(1, 20)
  buffer.writeUInt16LE(1, 22)
  buffer.writeUInt32LE(8_000, 24)
  buffer.writeUInt32LE(16_000, 28)
  buffer.writeUInt16LE(2, 32)
  buffer.writeUInt16LE(16, 34)
  buffer.write('data', 36)
  buffer.writeUInt32LE(sampleCount * 2, 40)
  return buffer
}

function uploadModalJSON(
  format: string | null,
  options: {
    contentType?: string
    name?: string
    public?: boolean
    selectedFormat?: string
    size?: number
  } = {}
): RawInteraction {
  const attachmentId = '555555555555555555'
  return modalJSON('', {
    data: {
      custom_id: `${FILECONV_MODAL_PREFIX}:${format ?? 'choose'}:${options.public ? 'public' : 'private'}`,
      resolved: {
        attachments: {
          [attachmentId]: {
            id: attachmentId,
            filename: options.name ?? 'photo.png',
            size: options.size ?? pngBuffer().byteLength,
            url: attachmentUrl,
            proxy_url: attachmentUrl,
            content_type: options.contentType ?? 'image/png'
          }
        }
      },
      components: [
        {
          type: ComponentType.Label,
          component: {
            type: ComponentType.FileUpload,
            custom_id: FILECONV_UPLOAD_ID,
            values: [attachmentId]
          }
        },
        ...(format === null
          ? [
              {
                type: ComponentType.Label,
                component: {
                  type: ComponentType.StringSelect,
                  custom_id: FILECONV_FORMAT_ID,
                  values: [options.selectedFormat ?? 'png']
                }
              }
            ]
          : [])
      ]
    }
  })
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

describe('fileconv runtime', () => {
  it('normalizes formats and output filenames', () => {
    expect(parseFileconvFormat('JPEG')).toBe('jpg')
    expect(parseFileconvFormat('pdf')).toBeNull()
    expect(convertedFileName('my unsafe image.PNG', 'webp')).toBe('my_unsafe_image.webp')
  })

  it('converts image data to the requested format', async () => {
    const output = await convertImage(pngBuffer(), 'jpg')
    const image = await loadImage(output)

    expect(output.subarray(0, 2)).toEqual(Buffer.from([0xff, 0xd8]))
    expect([image.width, image.height]).toEqual([2, 2])
  })

  it('converts audio data to the requested format', async () => {
    const output = await convertMedia(wavBuffer(), 'mp3')

    expect(output.byteLength).toBeGreaterThan(0)
    expect(output[0]).toBe(0xff)
  })

  it('rejects non-Discord attachment URLs', async () => {
    await expect(downloadDiscordAttachment('https://example.com/image.png')).rejects.toThrow(
      'invalid attachment URL'
    )
  })
})

describe('fileconv command', () => {
  it('opens a one-file upload modal for a valid target', async () => {
    const calls = await dispatch(commandJSON('fileconv webp'), subs)
    const body = getCallback(calls) as {
      type: number
      data: { custom_id: string; components: unknown[] }
    }

    expect(body.type).toBe(InteractionResponseType.Modal)
    expect(body.data.custom_id).toBe('fileconv:webp:private')
    expect(JSON.stringify(body.data.components)).toContain(`"type":${ComponentType.FileUpload}`)
    expect(JSON.stringify(body.data.components)).toContain(FILECONV_UPLOAD_ID)
  })

  it('adds an output format selector when the target is omitted', async () => {
    const calls = await dispatch(commandJSON('fileconv'), subs)
    const body = getCallback(calls) as {
      type: number
      data: { custom_id: string; components: unknown[] }
    }
    const serialized = JSON.stringify(body.data.components)

    expect(body.type).toBe(InteractionResponseType.Modal)
    expect(body.data.custom_id).toBe('fileconv:choose:private')
    expect(serialized).toContain(FILECONV_FORMAT_ID)
    expect(serialized).toContain('"value":"mp3"')
    expect(serialized).toContain('"value":"mp4"')
  })

  it('shows usage for an unsupported target', async () => {
    const calls = await dispatch(commandJSON('fileconv pdf'), subs)
    const body = getCallback(calls) as { type: number; data: { flags: number } }

    expect(body.type).toBe(InteractionResponseType.ChannelMessageWithSource)
    expect(body.data.flags & MessageFlags.Ephemeral).toBeTruthy()
    expect(JSON.stringify(body)).toContain('choose one of: png, jpg, webp')
  })

  it('downloads, converts, and attaches the uploaded image privately', async () => {
    const input = pngBuffer()
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        Promise.resolve(
          new Response(new Uint8Array(input), {
            headers: { 'content-length': String(input.byteLength), 'content-type': 'image/png' }
          })
        )
      )
    )

    const calls = await dispatch(uploadModalJSON('jpg'), subs)
    const defer = getCallback(calls) as { type: number; data: { flags: number } }
    const edit = getEdit(calls) as { components: unknown[] }
    const patch = calls.find((call) => call.method === 'PATCH')

    expect(defer.type).toBe(InteractionResponseType.DeferredChannelMessageWithSource)
    expect(defer.data.flags & MessageFlags.Ephemeral).toBeTruthy()
    expect(JSON.stringify(edit.components)).toContain('attachment://photo.jpg')
    expect(patch?.files).toHaveLength(1)
  })

  it('preserves public visibility through the modal', async () => {
    const input = pngBuffer()
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(new Uint8Array(input)))
    )

    const calls = await dispatch(uploadModalJSON('png', { public: true }), subs)
    const defer = getCallback(calls) as { data: { flags?: number } }

    expect((defer.data.flags ?? 0) & MessageFlags.Ephemeral).toBeFalsy()
  })

  it('uses the output format selected in the modal', async () => {
    const input = pngBuffer()
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(new Uint8Array(input)))
    )

    const calls = await dispatch(uploadModalJSON(null, { selectedFormat: 'jpg' }), subs)

    expect(JSON.stringify(getEdit(calls))).toContain('attachment://photo.jpg')
  })

  it('converts an uploaded audio file through the modal', async () => {
    const input = wavBuffer()
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(new Uint8Array(input)))
    )

    const calls = await dispatch(
      uploadModalJSON(null, {
        contentType: 'audio/wav',
        name: 'sound.wav',
        selectedFormat: 'mp3',
        size: input.byteLength
      }),
      subs
    )

    expect(JSON.stringify(getEdit(calls))).toContain('attachment://sound.mp3')
    expect(calls.find((call) => call.method === 'PATCH')?.files).toHaveLength(1)
  })

  it('shows an error when the source cannot be converted to the selected media format', async () => {
    const input = pngBuffer()
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(new Uint8Array(input)))
    )

    const calls = await dispatch(uploadModalJSON(null, { selectedFormat: 'mp3' }), subs)

    expect(JSON.stringify(getEdit(calls))).toContain('not a supported audio or video format')
  })

  it('rejects oversized uploads before downloading', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)

    const calls = await dispatch(uploadModalJSON('png', { size: 8 * 1024 * 1024 + 1 }), subs)

    expect(fetchMock).not.toHaveBeenCalled()
    expect(JSON.stringify(getEdit(calls))).toContain('file is too large')
  })

  it('autocompletes target formats', async () => {
    const calls = await dispatch(autocompleteJSON('fileconv w'), subs)
    const body = getCallback(calls) as { data: { choices: { value: string }[] } }

    expect(body.data.choices).toContainEqual({ name: 'fileconv webp', value: 'fileconv webp' })
  })
})
