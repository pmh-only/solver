import {
  AttachmentBuilder,
  FileBuilder,
  FileUploadBuilder,
  LabelBuilder,
  MessageFlags,
  ModalBuilder,
  type ModalSubmitInteraction
} from 'discord.js'
import type { Flags } from '../flags.js'
import type { Subcommand } from '../types.js'
import {
  commandContainer,
  commandReferenceReply,
  sendCommandReply,
  separator,
  summarySection,
  text
} from '../components.js'
import {
  convertedFileName,
  convertImage,
  downloadDiscordAttachment,
  FILECONV_MAX_INPUT_BYTES,
  parseFileconvFormat,
  type FileconvFormat
} from './fileconv-runtime.js'

export const FILECONV_MODAL_PREFIX = 'fileconv'
export const FILECONV_UPLOAD_ID = 'fileconv-upload'

const SUPPORTED_IMAGE_TYPES = new Set([
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/avif',
  'image/gif'
])

function modalId(format: FileconvFormat, pub: boolean): string {
  return `${FILECONV_MODAL_PREFIX}:${format}:${pub ? 'public' : 'private'}`
}

export function isFileconvModalId(customId: string): boolean {
  const match = /^fileconv:([a-z]+):(public|private)$/.exec(customId)
  return Boolean(match?.[1] && parseFileconvFormat(match[1]))
}

function parseModalId(customId: string): { format: FileconvFormat; pub: boolean } | null {
  const match = /^fileconv:([a-z]+):(public|private)$/.exec(customId)
  const format = match?.[1] ? parseFileconvFormat(match[1]) : null
  return format && match?.[2] ? { format, pub: match[2] === 'public' } : null
}

function buildUploadModal(format: FileconvFormat, pub: boolean) {
  return new ModalBuilder()
    .setCustomId(modalId(format, pub))
    .setTitle(`Convert image to ${format.toUpperCase()}`)
    .addComponents(
      new LabelBuilder()
        .setLabel('Image file')
        .setDescription('Upload one image, up to 8 MB and 4096 px per side.')
        .setFileUploadComponent(
          new FileUploadBuilder()
            .setCustomId(FILECONV_UPLOAD_ID)
            .setMinValues(1)
            .setMaxValues(1)
            .setRequired(true)
        )
    )
}

export async function handleFileconvModal(interaction: ModalSubmitInteraction) {
  const request = parseModalId(interaction.customId)
  if (!request) return

  const flags: Flags = request.pub ? new Map([['pub', true]]) : new Map()
  const args = `fileconv ${request.format}`
  await interaction.deferReply({ flags: request.pub ? undefined : MessageFlags.Ephemeral })

  try {
    const files = interaction.fields.getUploadedFiles(FILECONV_UPLOAD_ID, true)
    const attachment = files.first()
    if (!attachment) throw new Error('no file uploaded')
    if (attachment.size > FILECONV_MAX_INPUT_BYTES) {
      throw new Error('file is too large (8 MB maximum)')
    }
    if (attachment.contentType && !SUPPORTED_IMAGE_TYPES.has(attachment.contentType)) {
      throw new Error('file is not a supported image')
    }

    const input = await downloadDiscordAttachment(attachment.url)
    const output = await convertImage(input, request.format)
    const name = convertedFileName(attachment.name ?? 'converted', request.format)
    const reply = commandContainer(
      subcommand,
      args,
      flags,
      summarySection('File converted', ['Image conversion completed']),
      separator(),
      text(`**Output**\n\`${name}\` (${(output.byteLength / 1024).toFixed(1)} KiB)`),
      new FileBuilder().setURL(`attachment://${name}`)
    )
    reply.files.push(
      new AttachmentBuilder(output, {
        name,
        description: `${request.format.toUpperCase()} conversion of ${attachment.name ?? 'uploaded image'}`
      })
    )
    await sendCommandReply(interaction, reply)
  } catch (error) {
    const message = error instanceof Error ? error.message : 'file conversion failed'
    await sendCommandReply(
      interaction,
      commandReferenceReply(subcommand, args, flags, 'usage', message)
    )
  }
}

export const subcommand: Subcommand = {
  name: 'fileconv',
  description: 'convert an uploaded image to another format',
  usage: 'fileconv <png|jpg|webp|avif|gif> [--pub]',
  examples: ['fileconv png', 'fileconv webp --pub'],

  async autocomplete(restArgs) {
    const query = restArgs.trim().toLowerCase()
    return ['png', 'jpg', 'webp', 'avif', 'gif']
      .filter((format) => format.startsWith(query))
      .map((format) => ({ name: `fileconv ${format}`, value: `fileconv ${format}` }))
  },

  async execute(interaction, args, flags) {
    const target = args.replace(/^\S+\s*/, '').trim()
    const format = parseFileconvFormat(target)
    if (!format || target.split(/\s+/).length !== 1) {
      await sendCommandReply(
        interaction,
        commandReferenceReply(
          subcommand,
          args,
          flags,
          'usage',
          'choose png, jpg, webp, avif, or gif'
        )
      )
      return
    }

    if (!('showModal' in interaction)) {
      await sendCommandReply(
        interaction,
        commandReferenceReply(subcommand, args, flags, 'usage', 'run the command again to upload')
      )
      return
    }
    await interaction.showModal(buildUploadModal(format, flags.has('pub')))
  }
}
