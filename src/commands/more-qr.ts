import { AttachmentBuilder, MediaGalleryBuilder } from 'discord.js'
import QRCode from 'qrcode'
import type { Subcommand } from '../types.js'
import {
  commandContainer,
  commandReferenceReply,
  deferCommandResponse,
  sendCommandReply,
  summarySection
} from '../components.js'

export const qr: Subcommand = {
  name: 'qr',
  description: 'generate a QR code image',
  usage: 'qr <text> [--pub]',
  examples: ['qr https://example.com', 'qr hello world'],
  // Also hide the input in private replies so Publish cannot copy it into public text.
  hideInput: true,
  async execute(interaction, args, flags) {
    const value = args.replace(/^\S+\s*/, '').trim()
    // Leave room below QR byte-mode capacity at medium error correction.
    if (!value || Buffer.byteLength(value, 'utf8') > 2000) {
      await sendCommandReply(
        interaction,
        commandReferenceReply(
          qr,
          'qr',
          flags,
          'usage',
          value ? 'text must be at most 2000 UTF-8 bytes' : 'no text'
        )
      )
      return
    }
    await deferCommandResponse(interaction, flags)
    let image: Buffer
    try {
      image = await QRCode.toBuffer(value, {
        type: 'png',
        width: 512,
        margin: 4,
        errorCorrectionLevel: 'M'
      })
    } catch {
      await sendCommandReply(
        interaction,
        commandReferenceReply(qr, 'qr', flags, 'usage', 'could not generate QR image')
      )
      return
    }
    const payload = commandContainer(
      qr,
      args,
      flags,
      summarySection('QR code', []),
      new MediaGalleryBuilder().addItems({
        media: { url: 'attachment://qr.png' },
        description: 'QR code'
      })
    )
    payload.files.push(new AttachmentBuilder(image, { name: 'qr.png', description: 'QR code' }))
    await sendCommandReply(interaction, payload)
  }
}
