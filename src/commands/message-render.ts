import {
  ActionRowBuilder,
  type BaseMessageOptions,
  AttachmentBuilder,
  ComponentType,
  InteractionWebhook,
  MessageFlags,
  ModalBuilder,
  StringSelectMenuBuilder,
  StringSelectMenuInteraction,
  StringSelectMenuOptionBuilder,
  TextInputBuilder,
  TextInputStyle,
  type ModalSubmitInteraction,
  type Message,
  type MessageContextMenuCommandInteraction
} from 'discord.js'
import { createCanvas, loadImage, type SKRSContext2D } from '@napi-rs/canvas'
import {
  pinButtonRow,
  publishButtonRow,
  scheduleEphemeralMessageDelete,
  scheduleEphemeralReplyDelete,
  text
} from '../components.js'
import { getStoredValue, setStoredValue } from '../helpers/kv-store.js'
import { getAgentTimeZone } from '../helpers/timezone.js'
import {
  detectLocale,
  drawCanvasText,
  fontFamilyForText,
  GG_SANS_FAMILY,
  measureCanvasText,
  setCanvasFont as setFont,
  wrapCanvasText as wrapText,
  type LocaleKind
} from '../canvas.js'

export const MESSAGE_RENDER_COMMAND_NAME = 'Render Message'
export const MESSAGE_THREAD_START_COMMAND_NAME = 'Start Render Thread'
export const MESSAGE_THREAD_APPEND_COMMAND_NAME = 'Append To Render Thread'
export const MESSAGE_COLLECTION_EDIT_SELECT_ID = 'message-render-edit'
export const MESSAGE_COLLECTION_EDIT_MODAL_ID = 'message-render-edit-modal'
export const MESSAGE_COLLECTION_EDIT_INPUT_ID = 'message-render-edit-input'

const MAX_WIDTH = 920
const PADDING_X = 0
const PADDING_Y = 0
const AVATAR_SIZE = 40
const CONTENT_X = PADDING_X + AVATAR_SIZE + 16
const BODY_FONT_SIZE = 16
const BODY_LINE_HEIGHT = 20
const SUBTEXT_FONT_SIZE = 13
const SUBTEXT_LINE_HEIGHT = 16
const HEADING_FONT_SIZE = 20
const HEADING_LINE_HEIGHT = 24
const HEADER_FONT_SIZE = 16
const HEADER_LINE_HEIGHT = 20
const TIMESTAMP_FONT_SIZE = 12
const MESSAGE_GAP = 12
const CONTENT_WIDTH = MAX_WIDTH - CONTENT_X - PADDING_X

type StoredMessageSnapshot = {
  channelId: string
  messageId: string
  messageUrl: string
  authorTag: string
  avatarUrl: string
  displayName: string
  nameColor: string
  content: string
  createdTimestamp: number
}

type StoredCollection = {
  messages: StoredMessageSnapshot[]
  replyToken: string | null
}

type MessageLayout = {
  bodyLines: MessageBodyLine[]
  contentWidth: number
  height: number
  locale: LocaleKind
  displayName: string
  nameWidth: number
  timestamp: string
}

type MessageBodyLine = {
  text: string
  style: MessageLineStyle
}

type MessageLineStyle = 'body' | 'heading' | 'quote' | 'subtext'

export function formatMessageContentLine(value: string, markdown = true): MessageBodyLine {
  if (!markdown) return { text: value, style: 'body' }

  const subtext = value.match(/^\s*-#\s+(.*)$/)
  if (subtext) return { text: subtext[1]!, style: 'subtext' }

  const heading = value.match(/^\s{0,3}#{1,3}\s+(.*)$/)
  if (heading) return { text: heading[1]!, style: 'heading' }

  const task = value.match(/^(\s*)[-*+]\s+\[([ xX])\]\s+(.*)$/)
  if (task) {
    return {
      text: `${task[1]}${task[2]?.toLowerCase() === 'x' ? '☑' : '☐'} ${task[3]}`,
      style: 'body'
    }
  }

  const bullet = value.match(/^(\s*)[-*+]\s+(.*)$/)
  if (bullet) return { text: `${bullet[1]}• ${bullet[2]}`, style: 'body' }

  const quote = value.match(/^\s*>\s?(.*)$/)
  if (quote) return { text: `▎ ${quote[1]}`, style: 'quote' }

  if (/^\s*(?:-{3,}|_{3,}|\*{3,})\s*$/.test(value)) {
    return { text: '────────────────', style: 'subtext' }
  }

  return { text: value, style: 'body' }
}

function lineFont(style: MessageLineStyle) {
  switch (style) {
    case 'subtext':
      return { size: SUBTEXT_FONT_SIZE, height: SUBTEXT_LINE_HEIGHT, weight: 400 as const }
    case 'heading':
      return { size: HEADING_FONT_SIZE, height: HEADING_LINE_HEIGHT, weight: 700 as const }
    default:
      return { size: BODY_FONT_SIZE, height: BODY_LINE_HEIGHT, weight: 400 as const }
  }
}

function lineColor(style: MessageLineStyle) {
  return style === 'subtext' ? '#949ba4' : style === 'quote' ? '#b5bac1' : '#dbdee1'
}

function collectionKey(contextId: string, userId: string) {
  return `message-render-collection:${contextId}:${userId}`
}

function isStoredSnapshot(value: unknown): value is StoredMessageSnapshot {
  return (
    Boolean(value) &&
    typeof value === 'object' &&
    typeof (value as StoredMessageSnapshot).channelId === 'string' &&
    typeof (value as StoredMessageSnapshot).messageId === 'string' &&
    typeof (value as StoredMessageSnapshot).messageUrl === 'string' &&
    typeof (value as StoredMessageSnapshot).authorTag === 'string' &&
    typeof (value as StoredMessageSnapshot).avatarUrl === 'string' &&
    typeof (value as StoredMessageSnapshot).displayName === 'string' &&
    typeof (value as StoredMessageSnapshot).nameColor === 'string' &&
    typeof (value as StoredMessageSnapshot).content === 'string' &&
    typeof (value as StoredMessageSnapshot).createdTimestamp === 'number'
  )
}

function loadCollection(contextId: string, userId: string): StoredCollection {
  const raw = getStoredValue(collectionKey(contextId, userId))
  if (!raw) return { messages: [], replyToken: null }

  try {
    const parsed = JSON.parse(raw) as Partial<StoredCollection>
    return {
      messages: Array.isArray(parsed.messages) ? parsed.messages.filter(isStoredSnapshot) : [],
      replyToken: typeof parsed.replyToken === 'string' ? parsed.replyToken : null
    }
  } catch {
    return { messages: [], replyToken: null }
  }
}

function saveCollection(contextId: string, userId: string, collection: StoredCollection) {
  setStoredValue(collectionKey(contextId, userId), JSON.stringify(collection))
}

function basicReply(textValue: string) {
  return {
    components: [text(textValue), pinButtonRow()],
    flags: [MessageFlags.IsComponentsV2, MessageFlags.Ephemeral] as const
  }
}

async function replyAndScheduleDelete(
  interaction:
    | MessageContextMenuCommandInteraction
    | ModalSubmitInteraction
    | StringSelectMenuInteraction,
  payload: BaseMessageOptions & { flags: readonly number[] }
) {
  await interaction.reply(payload)
  const message = (await interaction.fetchReply()) as { id?: string }
  if (typeof message.id === 'string') {
    scheduleEphemeralReplyDelete(interaction, message.id, payload.flags)
  }
}

function truncate(value: string, max: number) {
  return value.length > max ? `${value.slice(0, max - 3)}...` : value
}

function formatTimestamp(createdAt: Date): string {
  return new Intl.DateTimeFormat('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    hour12: false,
    timeZone: getAgentTimeZone()
  }).format(createdAt)
}

async function fetchBuffer(url: string | null): Promise<Buffer | null> {
  if (!url) return null
  const response = await fetch(url)
  if (!response.ok) return null
  return Buffer.from(await response.arrayBuffer())
}

function clipRoundedRect(
  ctx: SKRSContext2D,
  x: number,
  y: number,
  width: number,
  height: number,
  radius: number
) {
  ctx.beginPath()
  ctx.moveTo(x + radius, y)
  ctx.arcTo(x + width, y, x + width, y + height, radius)
  ctx.arcTo(x + width, y + height, x, y + height, radius)
  ctx.arcTo(x, y + height, x, y, radius)
  ctx.arcTo(x, y, x + width, y, radius)
  ctx.closePath()
  ctx.clip()
}

function snapshotFromMessage(message: Message): StoredMessageSnapshot {
  const member = message.inGuild() ? message.member : null
  return {
    channelId: message.channelId,
    messageId: message.id,
    messageUrl: message.url,
    authorTag: message.author.tag,
    avatarUrl: message.author.displayAvatarURL({ extension: 'png', forceStatic: false, size: 128 }),
    displayName: member?.displayName ?? message.author.displayName,
    nameColor:
      member && 'displayHexColor' in member && member.displayHexColor !== '#000000'
        ? member.displayHexColor
        : '#f2f3f5',
    content: message.content,
    createdTimestamp: message.createdTimestamp
  }
}

function buildMessageLayout(
  message: StoredMessageSnapshot,
  locale: string,
  measure: SKRSContext2D
): MessageLayout {
  const bodyText = message.content.trim() || '[no text content]'
  const detectedLocale = detectLocale(locale, `${message.displayName}\n${bodyText}`)
  let fenced = false
  const bodyLines = bodyText.split(/\r?\n/).flatMap((value) => {
    const fence = /^\s*```/.test(value)
    const formatted = formatMessageContentLine(value, !fenced && !fence)
    if (fence) fenced = !fenced
    const font = lineFont(formatted.style)
    setFont(measure, font.weight, font.size, fontFamilyForText(formatted.text, detectedLocale))
    return wrapText(measure, formatted.text, CONTENT_WIDTH).map((text) => ({
      text,
      style: formatted.style
    }))
  })
  const bodyHeight = bodyLines.reduce((sum, line) => sum + lineFont(line.style).height, 0)
  setFont(measure, 500, HEADER_FONT_SIZE, fontFamilyForText(message.displayName, detectedLocale))
  const nameWidth = measureCanvasText(measure, message.displayName)
  const timestamp = formatTimestamp(new Date(message.createdTimestamp))
  setFont(measure, 400, TIMESTAMP_FONT_SIZE, GG_SANS_FAMILY)
  const timestampWidth = measureCanvasText(measure, timestamp)
  const bodyWidth = bodyLines.reduce((max, line) => {
    const font = lineFont(line.style)
    setFont(measure, font.weight, font.size, fontFamilyForText(line.text, detectedLocale))
    return Math.max(max, measureCanvasText(measure, line.text || ' '))
  }, 0)
  return {
    bodyLines,
    contentWidth: Math.max(nameWidth + 8 + timestampWidth, bodyWidth),
    height: Math.max(
      PADDING_Y * 2 + AVATAR_SIZE,
      PADDING_Y + HEADER_LINE_HEIGHT + 2 + bodyHeight + PADDING_Y
    ),
    locale: detectedLocale,
    displayName: message.displayName,
    nameWidth,
    timestamp
  }
}

async function renderMessagesPng(
  messages: StoredMessageSnapshot[],
  locale: string
): Promise<Buffer> {
  const measureCanvas = createCanvas(MAX_WIDTH, 200)
  const measure = measureCanvas.getContext('2d')
  const layouts = messages.map((message) => buildMessageLayout(message, locale, measure))
  const canvasWidth = Math.min(
    MAX_WIDTH,
    Math.ceil(CONTENT_X + Math.max(...layouts.map((layout) => layout.contentWidth)) + PADDING_X)
  )
  const totalHeight = layouts.reduce(
    (sum, layout, index) => sum + layout.height + (index > 0 ? MESSAGE_GAP : 0),
    0
  )

  const canvas = createCanvas(canvasWidth, totalHeight)
  const ctx = canvas.getContext('2d')

  let cursorY = 0
  for (const [index, message] of messages.entries()) {
    if (index > 0) cursorY += MESSAGE_GAP
    const layout = layouts[index]
    const avatarBuffer = await fetchBuffer(message.avatarUrl)
    const avatarImage = avatarBuffer ? await loadImage(avatarBuffer) : null

    if (avatarImage) {
      ctx.save()
      clipRoundedRect(
        ctx,
        PADDING_X,
        cursorY + PADDING_Y,
        AVATAR_SIZE,
        AVATAR_SIZE,
        AVATAR_SIZE / 2
      )
      ctx.drawImage(avatarImage, PADDING_X, cursorY + PADDING_Y, AVATAR_SIZE, AVATAR_SIZE)
      ctx.restore()
    } else {
      ctx.fillStyle = '#5865f2'
      ctx.beginPath()
      ctx.arc(
        PADDING_X + AVATAR_SIZE / 2,
        cursorY + PADDING_Y + AVATAR_SIZE / 2,
        AVATAR_SIZE / 2,
        0,
        Math.PI * 2
      )
      ctx.fill()
    }

    ctx.textBaseline = 'top'
    ctx.fillStyle = message.nameColor
    setFont(ctx, 500, HEADER_FONT_SIZE, fontFamilyForText(layout.displayName, layout.locale))
    drawCanvasText(ctx, layout.displayName, CONTENT_X, cursorY + PADDING_Y)
    ctx.fillStyle = '#949ba4'
    setFont(ctx, 400, TIMESTAMP_FONT_SIZE, GG_SANS_FAMILY)
    drawCanvasText(ctx, layout.timestamp, CONTENT_X + layout.nameWidth + 8, cursorY + PADDING_Y + 4)
    const bodyY = cursorY + PADDING_Y + HEADER_LINE_HEIGHT + 2
    let lineY = bodyY
    for (const line of layout.bodyLines) {
      const font = lineFont(line.style)
      ctx.fillStyle = message.content.trim() ? lineColor(line.style) : '#949ba4'
      setFont(ctx, font.weight, font.size, fontFamilyForText(line.text, layout.locale))
      drawCanvasText(ctx, line.text || ' ', CONTENT_X, lineY)
      lineY += font.height
    }
    cursorY += layout.height
  }

  return await canvas.encode('png')
}

function renderDescription(messages: StoredMessageSnapshot[]) {
  return messages.length === 1
    ? `Rendered view of ${messages[0]?.authorTag}'s message`
    : `Rendered view of ${messages.length} messages`
}

function imageReplyComponents(fileName: string, sourceUrl: string, description: string): unknown[] {
  return [
    {
      type: ComponentType.MediaGallery,
      items: [{ media: { url: `attachment://${fileName}` }, description }]
    },
    text(`-# [Open source](${sourceUrl})`),
    publishButtonRow()
  ]
}

function collectionEditRow(messages: StoredMessageSnapshot[]) {
  const select = new StringSelectMenuBuilder()
    .setCustomId(MESSAGE_COLLECTION_EDIT_SELECT_ID)
    .setPlaceholder('Edit message content')
    .addOptions(
      messages.slice(0, 25).map((message, index) =>
        new StringSelectMenuOptionBuilder()
          .setLabel(truncate(`${index + 1}. ${message.displayName}`, 100))
          .setValue(message.messageId)
          .setDescription(truncate(message.content.trim() || '[no text content]', 100))
      )
    )

  return new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(select)
}

function buildEditModal(message: StoredMessageSnapshot) {
  return new ModalBuilder()
    .setCustomId(`${MESSAGE_COLLECTION_EDIT_MODAL_ID}:${message.messageId}`)
    .setTitle('Edit message content')
    .addComponents(
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder()
          .setCustomId(MESSAGE_COLLECTION_EDIT_INPUT_ID)
          .setLabel('Content')
          .setStyle(TextInputStyle.Paragraph)
          .setRequired(true)
          .setValue(message.content || ' ')
          .setMaxLength(4000)
      )
    )
}

async function replyWithRenderedMessages(
  interaction: MessageContextMenuCommandInteraction | ModalSubmitInteraction,
  messages: StoredMessageSnapshot[],
  sourceUrl: string,
  editable: boolean
) {
  const png = await renderMessagesPng(messages, interaction.locale)
  const fileName = `message-render-${Date.now()}.png`
  const components: unknown[] = imageReplyComponents(
    fileName,
    sourceUrl,
    renderDescription(messages)
  )
  if (editable && messages.length > 0) {
    components.splice(2, 0, collectionEditRow(messages))
  }
  const payload = {
    files: [new AttachmentBuilder(png, { name: fileName })],
    components: components as never,
    flags: [MessageFlags.IsComponentsV2, MessageFlags.Ephemeral]
  } as const
  await replyAndScheduleDelete(interaction, payload)
}

async function updateStoredReply(
  interaction: MessageContextMenuCommandInteraction | ModalSubmitInteraction,
  messages: StoredMessageSnapshot[],
  sourceUrl: string,
  editable: boolean,
  replyToken: string | null
) {
  if (!replyToken) return false

  const applicationId = interaction.applicationId
  const png = await renderMessagesPng(messages, interaction.locale)
  const fileName = `message-render-${Date.now()}.png`
  const components: unknown[] = imageReplyComponents(
    fileName,
    sourceUrl,
    renderDescription(messages)
  )
  if (editable && messages.length > 0) {
    components.splice(2, 0, collectionEditRow(messages))
  }

  try {
    const webhook = new InteractionWebhook(interaction.client as never, applicationId, replyToken)
    await webhook.editMessage('@original', {
      files: [new AttachmentBuilder(png, { name: fileName })],
      components: components as never,
      flags: MessageFlags.IsComponentsV2
    })
    return true
  } catch {
    return false
  }
}

export async function handleMessageRenderCommand(
  interaction: MessageContextMenuCommandInteraction
) {
  await replyWithRenderedMessages(
    interaction,
    [snapshotFromMessage(interaction.targetMessage)],
    interaction.targetMessage.url,
    false
  )
}

export async function handleMessageThreadStartCommand(
  interaction: MessageContextMenuCommandInteraction
) {
  const contextId = interaction.guildId ?? interaction.channelId ?? interaction.user.id
  const collection: StoredCollection = {
    messages: [snapshotFromMessage(interaction.targetMessage)],
    replyToken: interaction.token
  }
  saveCollection(contextId, interaction.user.id, collection)
  await replyWithRenderedMessages(
    interaction,
    collection.messages,
    interaction.targetMessage.url,
    true
  )
}

export async function handleMessageThreadAppendCommand(
  interaction: MessageContextMenuCommandInteraction
) {
  const contextId = interaction.guildId ?? interaction.channelId ?? interaction.user.id
  const collection = loadCollection(contextId, interaction.user.id)
  if (collection.messages.length === 0) {
    await replyAndScheduleDelete(interaction, basicReply('no active render collection'))
    return
  }

  const nextSnapshot = snapshotFromMessage(interaction.targetMessage)
  const alreadyIncluded = collection.messages.some(
    (entry) =>
      entry.channelId === nextSnapshot.channelId && entry.messageId === nextSnapshot.messageId
  )
  const nextMessages = alreadyIncluded
    ? collection.messages
    : [...collection.messages, nextSnapshot]
  saveCollection(contextId, interaction.user.id, {
    messages: nextMessages,
    replyToken: collection.replyToken
  })

  await interaction.deferReply({ flags: MessageFlags.Ephemeral })
  const updated = await updateStoredReply(
    interaction,
    nextMessages,
    interaction.targetMessage.url,
    true,
    collection.replyToken
  )

  if (updated) {
    await interaction.deleteReply()
    return
  }

  await interaction.editReply({
    components: [text('could not update original reply; sent fallback below')],
    flags: MessageFlags.IsComponentsV2
  })
  const followUp = (await interaction.followUp({
    ...(await (async () => {
      const png = await renderMessagesPng(nextMessages, interaction.locale)
      const fileName = `message-render-${Date.now()}.png`
      const components: unknown[] = imageReplyComponents(
        fileName,
        interaction.targetMessage.url,
        renderDescription(nextMessages)
      )
      components.splice(2, 0, collectionEditRow(nextMessages))
      return {
        files: [new AttachmentBuilder(png, { name: fileName })],
        components: components as never,
        flags: [MessageFlags.IsComponentsV2, MessageFlags.Ephemeral] as const
      }
    })())
  })) as { id?: string }
  if (typeof followUp.id === 'string') {
    scheduleEphemeralMessageDelete(interaction.webhook, followUp.id, [
      MessageFlags.IsComponentsV2,
      MessageFlags.Ephemeral
    ])
  }
}

export async function handleMessageCollectionEditSelect(interaction: StringSelectMenuInteraction) {
  const messageId = interaction.values[0]
  if (!messageId) {
    await replyAndScheduleDelete(interaction, basicReply('no msg'))
    return
  }

  const collection = loadCollection(
    interaction.guildId ?? interaction.channelId ?? interaction.user.id,
    interaction.user.id
  )
  const message = collection.messages.find((entry) => entry.messageId === messageId)
  if (!message) {
    await replyAndScheduleDelete(interaction, basicReply('no msg'))
    return
  }

  await interaction.showModal(buildEditModal(message))
}

export async function handleMessageCollectionEditModal(interaction: ModalSubmitInteraction) {
  const contextId = interaction.guildId ?? interaction.channelId ?? interaction.user.id

  const prefix = `${MESSAGE_COLLECTION_EDIT_MODAL_ID}:`
  const messageId = interaction.customId.startsWith(prefix)
    ? interaction.customId.slice(prefix.length)
    : null
  if (!messageId) {
    await replyAndScheduleDelete(interaction, basicReply('err'))
    return
  }

  const collection = loadCollection(contextId, interaction.user.id)
  const nextContent = interaction.fields.getTextInputValue(MESSAGE_COLLECTION_EDIT_INPUT_ID)
  const nextMessages = collection.messages.map((entry) =>
    entry.messageId === messageId ? { ...entry, content: nextContent } : entry
  )
  saveCollection(contextId, interaction.user.id, {
    messages: nextMessages,
    replyToken: collection.replyToken
  })

  const edited = nextMessages.find((entry) => entry.messageId === messageId)
  const updated = await updateStoredReply(
    interaction,
    nextMessages,
    edited?.messageUrl ?? nextMessages[0]?.messageUrl ?? 'https://discord.com/channels/@me',
    true,
    collection.replyToken
  )

  if (updated) {
    const reply = basicReply('updated')
    await interaction.reply(reply)
    await interaction.deleteReply()
    return
  }

  await replyWithRenderedMessages(
    interaction,
    nextMessages,
    edited?.messageUrl ?? nextMessages[0]?.messageUrl ?? 'https://discord.com/channels/@me',
    true
  )
}
