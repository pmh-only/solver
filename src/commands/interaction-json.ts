import {
  MessageFlags,
  type MessageContextMenuCommandInteraction,
  type UserContextMenuCommandInteraction
} from 'discord.js'
import {
  scheduleEphemeralMessageDelete,
  scheduleEphemeralReplyDelete,
  text
} from '../components.js'
import { createCanvasMedia } from '../canvas-presentation.js'

export const USER_INTERACTION_JSON_COMMAND_NAME = 'User Interaction JSON'
export const MESSAGE_INTERACTION_JSON_COMMAND_NAME = 'Message Interaction JSON'

const MAX_TEXT_COMPONENT_SIZE = 4000

function jsonStringify(value: unknown) {
  return JSON.stringify(
    value,
    (_, entry) => (typeof entry === 'bigint' ? entry.toString() : entry),
    2
  )
}

function userInteractionData(interaction: UserContextMenuCommandInteraction) {
  return {
    interaction: interaction.toJSON(),
    targetUser: interaction.targetUser.toJSON()
  }
}

function messageInteractionData(interaction: MessageContextMenuCommandInteraction) {
  return {
    interaction: interaction.toJSON(),
    targetMessage: interaction.targetMessage.toJSON()
  }
}

function chunkString(value: string, size: number) {
  const chunks: string[] = []

  for (let index = 0; index < value.length; index += size) {
    chunks.push(value.slice(index, index + size))
  }

  return chunks.length > 0 ? chunks : ['']
}

function buildJsonPages(title: string, json: string) {
  const titlePrefix = `## ${title}\n-# ${json.length.toLocaleString('en-US')} chars\n\n`
  const suffix = '\n```'
  let pageCount = 1

  while (true) {
    const maxDigits = String(pageCount).length
    const partPrefixLength =
      `**Part ${'9'.repeat(maxDigits)}/${'9'.repeat(maxDigits)}**\n\n\`\`\`json\n`.length
    const chunkSize =
      MAX_TEXT_COMPONENT_SIZE - titlePrefix.length - partPrefixLength - suffix.length
    const chunks = chunkString(json, chunkSize)

    if (chunks.length === pageCount) {
      return chunks.map(
        (chunk, index) =>
          `${index === 0 ? titlePrefix : ''}**Part ${index + 1}/${chunks.length}**\n\n\`\`\`json\n${chunk}\n\`\`\``
      )
    }

    pageCount = chunks.length
  }
}

async function replyWithInteractionJson(
  interaction: MessageContextMenuCommandInteraction | UserContextMenuCommandInteraction,
  title: string,
  data: unknown
) {
  const json = jsonStringify(data)
  const pages = buildJsonPages(title, json)
  const flags = [MessageFlags.IsComponentsV2, MessageFlags.Ephemeral] as const
  const canvas = createCanvasMedia({
    id: 'interaction-json',
    title,
    kicker: 'Developer inspector',
    lines: [
      `${json.length.toLocaleString('en-US')} characters`,
      `${pages.length} page${pages.length === 1 ? '' : 's'}`
    ],
    accent: 0x64748b
  })
  const firstPayload = {
    components: [canvas.gallery, text(pages[0] ?? '')],
    files: [canvas.file],
    flags
  }

  await interaction.reply(firstPayload)
  const message = (await interaction.fetchReply()) as { id?: string }
  if (typeof message.id === 'string') {
    scheduleEphemeralReplyDelete(interaction, message.id, flags)
  }

  for (const page of pages.slice(1)) {
    const followUp = (await interaction.followUp({
      components: [text(page)],
      flags
    })) as { id?: string }

    if (typeof followUp.id === 'string') {
      scheduleEphemeralMessageDelete(interaction.webhook, followUp.id, flags)
    }
  }
}

export async function handleUserInteractionJsonCommand(
  interaction: UserContextMenuCommandInteraction
) {
  await replyWithInteractionJson(
    interaction,
    `Interaction JSON for ${interaction.targetUser.displayName}`,
    userInteractionData(interaction)
  )
}

export async function handleMessageInteractionJsonCommand(
  interaction: MessageContextMenuCommandInteraction
) {
  await replyWithInteractionJson(
    interaction,
    `Interaction JSON for message ${interaction.targetMessage.id}`,
    messageInteractionData(interaction)
  )
}
