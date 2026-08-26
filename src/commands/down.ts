import { AttachmentBuilder, FileBuilder } from 'discord.js'
import type { Subcommand } from '../types.js'
import {
  commandReferenceReply,
  container,
  deferCommandResponse,
  sendCommandReply,
  separator,
  summarySection,
  text
} from '../components.js'
import { downloadUrl, safeDownloadLabel } from './down-runtime.js'

export const subcommand: Subcommand = {
  name: 'down',
  description: 'download a URL and upload the file to Discord',
  usage: 'down <http-or-https-url> [--pub]',
  examples: ['down https://example.com/file.zip'],

  async execute(interaction, args, flags) {
    const input = args.replace(/^\S+\s*/, '').trim()
    if (!input || input.split(/\s+/).length !== 1) {
      await sendCommandReply(
        interaction,
        commandReferenceReply(subcommand, 'down', flags, 'usage', 'provide one URL')
      )
      return
    }

    const safeArgs = `down ${safeDownloadLabel(input)}`
    await deferCommandResponse(interaction, flags)
    try {
      const result = await downloadUrl(input)
      const payload = container(
        safeArgs,
        flags,
        summarySection('Download complete', [
          `-# file: ${result.fileName}`,
          `-# size: ${(result.data.byteLength / 1024 / 1024).toFixed(2)} MB`,
          `-# type: ${result.contentType}`
        ]),
        separator(),
        text(`**File**\n\`${result.fileName.replaceAll('`', '_')}\``),
        new FileBuilder().setURL(`attachment://${result.fileName}`)
      )
      payload.files.push(
        new AttachmentBuilder(result.data, {
          name: result.fileName,
          description: `Downloaded from ${safeDownloadLabel(result.finalUrl)}`
        })
      )
      await sendCommandReply(interaction, payload)
    } catch (error) {
      const message = error instanceof Error ? error.message : 'download failed'
      await sendCommandReply(
        interaction,
        container(safeArgs, flags, summarySection('Download failed', [message]))
      )
    }
  }
}
