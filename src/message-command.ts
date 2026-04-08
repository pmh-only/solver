import {
  ActionRowBuilder,
  AttachmentBuilder,
  ButtonBuilder,
  ButtonStyle,
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
import { createCanvas, GlobalFonts, loadImage, type SKRSContext2D } from '@napi-rs/canvas'
import { fileURLToPath } from 'node:url'
import { PUB_BUTTON_ID, text } from './components.js'
import { getStoredValue, setStoredValue } from './helpers/kv-store.js'

export const MESSAGE_RENDER_COMMAND_NAME = 'Render Message'
export const MESSAGE_THREAD_START_COMMAND_NAME = 'Start Render Thread'
export const MESSAGE_THREAD_APPEND_COMMAND_NAME = 'Append To Render Thread'
export const MESSAGE_COLLECTION_EDIT_SELECT_ID = 'message-render-edit'
export const MESSAGE_COLLECTION_EDIT_MODAL_ID = 'message-render-edit-modal'
export const MESSAGE_COLLECTION_EDIT_INPUT_ID = 'message-render-edit-input'

const MAX_WIDTH = 920
const PADDING_X = 16
const PADDING_Y = 2
const AVATAR_SIZE = 40
const CONTENT_X = PADDING_X + AVATAR_SIZE + 16
const BODY_FONT_SIZE = 16
const BODY_LINE_HEIGHT = 22
const HEADER_FONT_SIZE = 16
const HEADER_LINE_HEIGHT = 20
const TIMESTAMP_FONT_SIZE = 12
const MESSAGE_GAP = 12
const CONTENT_WIDTH = MAX_WIDTH - CONTENT_X - PADDING_X

const GG_SANS_REGULAR = fileURLToPath(new URL('../assets/fonts/gg-sans-400.woff2', import.meta.url))
const GG_SANS_MEDIUM = fileURLToPath(new URL('../assets/fonts/gg-sans-500.woff2', import.meta.url))
const GG_SANS_BOLD = fileURLToPath(new URL('../assets/fonts/gg-sans-700.woff2', import.meta.url))
const NOTO_SANS_CJK_JP = fileURLToPath(
  new URL('../assets/fonts/NotoSansCJKjp-Regular.otf', import.meta.url)
)
const NOTO_SANS_CJK_KR = fileURLToPath(
  new URL('../assets/fonts/NotoSansCJKkr-Regular.otf', import.meta.url)
)
const NOTO_SANS_CJK_SC = fileURLToPath(
  new URL('../assets/fonts/NotoSansCJKsc-Regular.otf', import.meta.url)
)
const NOTO_SANS_CJK_TC = fileURLToPath(
  new URL('../assets/fonts/NotoSansCJKtc-Regular.otf', import.meta.url)
)

const GG_SANS_FAMILY = 'gg sans'
const KO_FAMILY = 'discord-cjk-ko'
const JA_FAMILY = 'discord-cjk-ja'
const ZH_CN_FAMILY = 'discord-cjk-zh-cn'
const ZH_TW_FAMILY = 'discord-cjk-zh-tw'

type LocaleKind = 'ko' | 'ja' | 'zh-CN' | 'zh-TW' | 'default'

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
  bodyLines: string[]
  contentWidth: number
  height: number
  locale: LocaleKind
  displayName: string
  nameWidth: number
  timestamp: string
}

GlobalFonts.registerFromPath(GG_SANS_REGULAR, GG_SANS_FAMILY)
GlobalFonts.registerFromPath(GG_SANS_MEDIUM, GG_SANS_FAMILY)
GlobalFonts.registerFromPath(GG_SANS_BOLD, GG_SANS_FAMILY)
GlobalFonts.registerFromPath(NOTO_SANS_CJK_KR, KO_FAMILY)
GlobalFonts.registerFromPath(NOTO_SANS_CJK_JP, JA_FAMILY)
GlobalFonts.registerFromPath(NOTO_SANS_CJK_SC, ZH_CN_FAMILY)
GlobalFonts.registerFromPath(NOTO_SANS_CJK_TC, ZH_TW_FAMILY)

function publishButtonRow() {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(PUB_BUTTON_ID).setLabel('Publish').setStyle(ButtonStyle.Success)
  )
}

function collectionKey(guildId: string, userId: string) {
  return `message-render-collection:${guildId}:${userId}`
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

function loadCollection(guildId: string, userId: string): StoredCollection {
  const raw = getStoredValue(collectionKey(guildId, userId))
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

function saveCollection(guildId: string, userId: string, collection: StoredCollection) {
  setStoredValue(collectionKey(guildId, userId), JSON.stringify(collection))
}

function basicReply(textValue: string) {
  return {
    components: [text(textValue)],
    flags: [MessageFlags.IsComponentsV2, MessageFlags.Ephemeral] as const
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
    timeZone: 'Asia/Seoul'
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

function wrapText(ctx: SKRSContext2D, value: string, maxWidth: number) {
  const lines: string[] = []
  for (const paragraph of value.split(/\r?\n/)) {
    if (!paragraph.trim()) {
      lines.push('')
      continue
    }
    let current = ''
    for (const token of paragraph.match(/\s+|\S+/g) ?? []) {
      const candidate = `${current}${token}`
      if (ctx.measureText(candidate).width <= maxWidth || !current) {
        current = candidate
        continue
      }
      lines.push(current)
      current = token.trimStart()
      while (ctx.measureText(current).width > maxWidth && current.length > 1) {
        const chars = [...current]
        let splitIndex = chars.length - 1
        while (
          splitIndex > 1 &&
          ctx.measureText(chars.slice(0, splitIndex).join('')).width > maxWidth
        ) {
          splitIndex--
        }
        lines.push(chars.slice(0, splitIndex).join(''))
        current = chars.slice(splitIndex).join('')
      }
    }
    if (current) lines.push(current)
  }
  return lines.length > 0 ? lines : ['']
}

function detectLocale(locale: string, text: string): LocaleKind {
  if (/[\uac00-\ud7af]/u.test(text)) return 'ko'
  if (/[\u3040-\u30ff]/u.test(text)) return 'ja'
  if (/[\u3400-\u9fff\uf900-\ufaff]/u.test(text)) {
    return locale.startsWith('zh-TW') || locale.startsWith('zh-HK') ? 'zh-TW' : 'zh-CN'
  }
  if (locale.startsWith('ko')) return 'ko'
  if (locale.startsWith('ja')) return 'ja'
  if (locale.startsWith('zh-TW') || locale.startsWith('zh-HK')) return 'zh-TW'
  if (locale.startsWith('zh')) return 'zh-CN'
  return 'default'
}

function fontFamilyForLocale(locale: LocaleKind) {
  switch (locale) {
    case 'ko':
      return KO_FAMILY
    case 'ja':
      return JA_FAMILY
    case 'zh-CN':
      return ZH_CN_FAMILY
    case 'zh-TW':
      return ZH_TW_FAMILY
    default:
      return GG_SANS_FAMILY
  }
}

function fontFamilyForText(text: string, locale: LocaleKind) {
  if (/[\uac00-\ud7af]/u.test(text)) return KO_FAMILY
  if (/[\u3040-\u30ff]/u.test(text)) return JA_FAMILY
  if (/[\u3400-\u9fff\uf900-\ufaff]/u.test(text)) {
    if (locale === 'zh-TW') return ZH_TW_FAMILY
    if (locale === 'zh-CN') return ZH_CN_FAMILY
    return JA_FAMILY
  }
  return fontFamilyForLocale(locale)
}

function setFont(ctx: SKRSContext2D, weight: 400 | 500 | 700, size: number, family: string) {
  ctx.font = `${weight} ${size}px "${family}"`
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
  setFont(measure, 400, BODY_FONT_SIZE, fontFamilyForText(bodyText, detectedLocale))
  const bodyLines = wrapText(measure, bodyText, CONTENT_WIDTH)
  const bodyHeight = bodyLines.length * BODY_LINE_HEIGHT
  setFont(measure, 500, HEADER_FONT_SIZE, fontFamilyForText(message.displayName, detectedLocale))
  const nameWidth = measure.measureText(message.displayName).width
  const timestamp = formatTimestamp(new Date(message.createdTimestamp))
  setFont(measure, 400, TIMESTAMP_FONT_SIZE, GG_SANS_FAMILY)
  const timestampWidth = measure.measureText(timestamp).width
  const bodyWidth = bodyLines.reduce((max, line) => {
    setFont(measure, 400, BODY_FONT_SIZE, fontFamilyForText(line, detectedLocale))
    return Math.max(max, measure.measureText(line || ' ').width)
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
  ctx.fillStyle = '#313338'
  ctx.fillRect(0, 0, canvasWidth, totalHeight)

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
    ctx.fillText(layout.displayName, CONTENT_X, cursorY + PADDING_Y)
    ctx.fillStyle = '#949ba4'
    setFont(ctx, 400, TIMESTAMP_FONT_SIZE, GG_SANS_FAMILY)
    ctx.fillText(layout.timestamp, CONTENT_X + layout.nameWidth + 8, cursorY + PADDING_Y + 4)
    ctx.fillStyle = message.content.trim() ? '#dbdee1' : '#949ba4'
    const bodyY = cursorY + PADDING_Y + HEADER_LINE_HEIGHT + 2
    layout.bodyLines.forEach((line, lineIndex) => {
      setFont(ctx, 400, BODY_FONT_SIZE, fontFamilyForText(line, layout.locale))
      ctx.fillText(line || ' ', CONTENT_X, bodyY + lineIndex * BODY_LINE_HEIGHT)
    })
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
  await interaction.reply({
    files: [new AttachmentBuilder(png, { name: fileName })],
    components: components as never,
    flags: [MessageFlags.IsComponentsV2, MessageFlags.Ephemeral]
  })
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
  if (!interaction.guildId) {
    await interaction.reply(basicReply('collection requires guild msg'))
    return
  }
  const collection: StoredCollection = {
    messages: [snapshotFromMessage(interaction.targetMessage)],
    replyToken: interaction.token
  }
  saveCollection(interaction.guildId, interaction.user.id, collection)
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
  if (!interaction.guildId) {
    await interaction.reply(basicReply('collection requires guild msg'))
    return
  }

  const collection = loadCollection(interaction.guildId, interaction.user.id)
  if (collection.messages.length === 0) {
    await interaction.reply(basicReply('no active render collection'))
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
  saveCollection(interaction.guildId, interaction.user.id, {
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
  await interaction.followUp({
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
  })
}

export async function handleMessageCollectionEditSelect(interaction: StringSelectMenuInteraction) {
  if (!interaction.guildId) {
    await interaction.reply(basicReply('collection requires guild msg'))
    return
  }

  const messageId = interaction.values[0]
  if (!messageId) {
    await interaction.reply(basicReply('no msg'))
    return
  }

  const collection = loadCollection(interaction.guildId, interaction.user.id)
  const message = collection.messages.find((entry) => entry.messageId === messageId)
  if (!message) {
    await interaction.reply(basicReply('no msg'))
    return
  }

  await interaction.showModal(buildEditModal(message))
}

export async function handleMessageCollectionEditModal(interaction: ModalSubmitInteraction) {
  if (!interaction.guildId) {
    await interaction.reply(basicReply('collection requires guild msg'))
    return
  }

  const prefix = `${MESSAGE_COLLECTION_EDIT_MODAL_ID}:`
  const messageId = interaction.customId.startsWith(prefix)
    ? interaction.customId.slice(prefix.length)
    : null
  if (!messageId) {
    await interaction.reply(basicReply('err'))
    return
  }

  const collection = loadCollection(interaction.guildId, interaction.user.id)
  const nextContent = interaction.fields.getTextInputValue(MESSAGE_COLLECTION_EDIT_INPUT_ID)
  const nextMessages = collection.messages.map((entry) =>
    entry.messageId === messageId ? { ...entry, content: nextContent } : entry
  )
  saveCollection(interaction.guildId, interaction.user.id, {
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
    await interaction.reply(basicReply('updated'))
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
