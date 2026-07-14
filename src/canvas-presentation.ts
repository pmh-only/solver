import {
  ActionRowBuilder,
  AttachmentBuilder,
  ButtonBuilder,
  ContainerBuilder,
  MediaGalleryBuilder,
  SeparatorBuilder,
  SeparatorSpacingSize,
  TextDisplayBuilder
} from 'discord.js'
import { randomUUID } from 'node:crypto'
import { renderVisualCard, type CardVisual } from './canvas.js'

export interface CanvasPresentationOptions {
  id: string
  fileName?: string
  title: string
  kicker: string
  lines: string[]
  descriptionLines?: string[]
  accent: number
  footer?: string
  visual?: CardVisual
}

export interface GamePresentationOptions extends CanvasPresentationOptions {
  controls?: ActionRowBuilder<ButtonBuilder>[]
}

export interface GamePresentation {
  components: Array<ContainerBuilder | ActionRowBuilder<ButtonBuilder>>
  files: AttachmentBuilder[]
}

function truncate(value: string, max: number) {
  return value.length > max ? `${value.slice(0, max - 3)}...` : value
}

function safeFilePart(value: string) {
  return (
    value
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 32) || 'card'
  )
}

export function createCanvasMedia(options: CanvasPresentationOptions) {
  const fileName = options.fileName ?? `${safeFilePart(options.id)}-${randomUUID().slice(0, 8)}.png`
  const description = truncate(
    [options.title, ...(options.descriptionLines ?? options.lines)].join('\n'),
    1000
  )
  const image = renderVisualCard(options)
  const file = new AttachmentBuilder(image, { name: fileName, description })
  const gallery = new MediaGalleryBuilder({
    items: [{ media: { url: `attachment://${fileName}` }, description }]
  })

  return { file, gallery }
}

export function createGamePresentation(options: GamePresentationOptions): GamePresentation {
  const { file, gallery } = createCanvasMedia(options)
  const container = new ContainerBuilder()
    .setAccentColor(options.accent)
    .addMediaGalleryComponents(gallery)

  if (options.footer) {
    container
      .addSeparatorComponents(
        new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small).setDivider(true)
      )
      .addTextDisplayComponents(new TextDisplayBuilder().setContent(`-# \`${options.footer}\``))
  }

  return { components: [container, ...(options.controls ?? [])], files: [file] }
}
