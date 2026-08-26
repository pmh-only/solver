import {
  AttachmentBuilder,
  FileBuilder,
  FileUploadBuilder,
  LabelBuilder,
  MessageFlags,
  ModalBuilder,
  StringSelectMenuBuilder,
  StringSelectMenuOptionBuilder,
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
  convertMedia,
  downloadDiscordAttachment,
  FILECONV_AUDIO_FORMATS,
  FILECONV_FORMATS,
  FILECONV_IMAGE_FORMATS,
  FILECONV_MAX_INPUT_BYTES,
  FILECONV_VIDEO_FORMATS,
  isImageFormat,
  parseFileconvFormat,
  type FileconvFormat
} from './fileconv-runtime.js'

export const FILECONV_MODAL_PREFIX = 'fileconv'
export const FILECONV_UPLOAD_ID = 'fileconv-upload'
export const FILECONV_FORMAT_ID = 'fileconv-format'

function modalId(format: FileconvFormat | null, pub: boolean): string {
  return `${FILECONV_MODAL_PREFIX}:${format ?? 'choose'}:${pub ? 'public' : 'private'}`
}

export function isFileconvModalId(customId: string): boolean {
  const match = /^fileconv:([a-z]+):(public|private)$/.exec(customId)
  return Boolean(match?.[1] && (match[1] === 'choose' || parseFileconvFormat(match[1])))
}

function parseModalId(customId: string): { format: FileconvFormat | null; pub: boolean } | null {
  const match = /^fileconv:([a-z]+):(public|private)$/.exec(customId)
  if (!match?.[1] || !match[2]) return null
  const format = match[1] === 'choose' ? null : parseFileconvFormat(match[1])
  return match[1] === 'choose' || format ? { format, pub: match[2] === 'public' } : null
}

function formatOption(format: FileconvFormat, type: string) {
  return new StringSelectMenuOptionBuilder()
    .setLabel(format.toUpperCase())
    .setValue(format)
    .setDescription(`${type} output`)
}

function buildUploadModal(format: FileconvFormat | null, pub: boolean) {
  const modal = new ModalBuilder()
    .setCustomId(modalId(format, pub))
    .setTitle(format ? `Convert file to ${format.toUpperCase()}` : 'Convert file')
    .addComponents(
      new LabelBuilder()
        .setLabel('Media file')
        .setDescription('Upload one image, audio, or video file up to 8 MB.')
        .setFileUploadComponent(
          new FileUploadBuilder()
            .setCustomId(FILECONV_UPLOAD_ID)
            .setMinValues(1)
            .setMaxValues(1)
            .setRequired(true)
        )
    )

  if (!format) {
    modal.addComponents(
      new LabelBuilder()
        .setLabel('Output format')
        .setDescription('Choose the file type to create.')
        .setStringSelectMenuComponent(
          new StringSelectMenuBuilder()
            .setCustomId(FILECONV_FORMAT_ID)
            .setPlaceholder('Choose an output format')
            .setMinValues(1)
            .setMaxValues(1)
            .addOptions(
              ...FILECONV_IMAGE_FORMATS.map((value) => formatOption(value, 'Image')),
              ...FILECONV_AUDIO_FORMATS.map((value) => formatOption(value, 'Audio')),
              ...FILECONV_VIDEO_FORMATS.map((value) => formatOption(value, 'Video'))
            )
        )
    )
  }

  return modal
}

export async function handleFileconvModal(interaction: ModalSubmitInteraction) {
  const request = parseModalId(interaction.customId)
  if (!request) return

  const selected = request.format
    ? request.format
    : parseFileconvFormat(interaction.fields.getStringSelectValues(FILECONV_FORMAT_ID)[0] ?? '')
  const flags: Flags = request.pub ? new Map([['pub', true]]) : new Map()
  const args = selected ? `fileconv ${selected}` : 'fileconv'
  await interaction.deferReply({ flags: request.pub ? undefined : MessageFlags.Ephemeral })

  try {
    if (!selected) throw new Error('no output format selected')
    const files = interaction.fields.getUploadedFiles(FILECONV_UPLOAD_ID, true)
    const attachment = files.first()
    if (!attachment) throw new Error('no file uploaded')
    if (attachment.size > FILECONV_MAX_INPUT_BYTES) {
      throw new Error('file is too large (8 MB maximum)')
    }
    const input = await downloadDiscordAttachment(attachment.url)
    const output = isImageFormat(selected)
      ? await convertImage(input, selected)
      : await convertMedia(input, selected)
    const name = convertedFileName(attachment.name ?? 'converted', selected)
    const reply = commandContainer(
      subcommand,
      args,
      flags,
      summarySection('File converted', ['Media conversion completed']),
      separator(),
      text(`**Output**\n\`${name}\` (${(output.byteLength / 1024).toFixed(1)} KiB)`),
      new FileBuilder().setURL(`attachment://${name}`)
    )
    reply.files.push(
      new AttachmentBuilder(output, {
        name,
        description: `${selected.toUpperCase()} conversion of ${attachment.name ?? 'uploaded media'}`
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
  description: 'convert an uploaded image, audio, or video file',
  usage: 'fileconv [format] [--pub]',
  examples: ['fileconv', 'fileconv webp', 'fileconv mp3 --pub'],

  async autocomplete(restArgs) {
    const query = restArgs.trim().toLowerCase()
    return FILECONV_FORMATS.filter((format) => format.startsWith(query)).map((format) => ({
      name: `fileconv ${format}`,
      value: `fileconv ${format}`
    }))
  },

  async execute(interaction, args, flags) {
    const target = args.replace(/^\S+\s*/, '').trim()
    const format = target ? parseFileconvFormat(target) : null
    if (target && (!format || target.split(/\s+/).length !== 1)) {
      await sendCommandReply(
        interaction,
        commandReferenceReply(
          subcommand,
          args,
          flags,
          'usage',
          `choose one of: ${FILECONV_FORMATS.join(', ')}`
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
