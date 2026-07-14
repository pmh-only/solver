import {
  ActionRowBuilder,
  MessageFlags,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  type MessageContextMenuCommandInteraction,
  type ModalSubmitInteraction
} from 'discord.js'
import { pinButtonRow, scheduleEphemeralReplyDelete, text } from '../components.js'
import { getStoredValue, setStoredValue } from '../helpers/kv-store.js'

export const MESSAGE_STORE_COMMAND_NAME = 'Store Message'
export const MESSAGE_STORE_MODAL_ID = 'message-store-modal'
export const MESSAGE_STORE_KEY_INPUT_ID = 'message-store-key'

const KV_PREFIX = 'message-store-pending:'

function pendingKey(userId: string) {
  return `${KV_PREFIX}${userId}`
}

function storeReply(message: string) {
  return {
    components: [text(message), pinButtonRow()],
    flags: [MessageFlags.IsComponentsV2, MessageFlags.Ephemeral] as const
  }
}

export async function handleMessageStoreCommand(interaction: MessageContextMenuCommandInteraction) {
  const content = interaction.targetMessage.content
  if (!content.trim()) {
    const payload = storeReply('Message has no text content.')
    await interaction.reply(payload)
    const message = (await interaction.fetchReply()) as { id?: string }
    if (typeof message.id === 'string') {
      scheduleEphemeralReplyDelete(interaction, message.id, payload.flags)
    }
    return
  }

  setStoredValue(pendingKey(interaction.user.id), content)

  await interaction.showModal(
    new ModalBuilder()
      .setCustomId(MESSAGE_STORE_MODAL_ID)
      .setTitle('Store message')
      .addComponents(
        new ActionRowBuilder<TextInputBuilder>().addComponents(
          new TextInputBuilder()
            .setCustomId(MESSAGE_STORE_KEY_INPUT_ID)
            .setLabel('Key')
            .setStyle(TextInputStyle.Short)
            .setRequired(true)
            .setMaxLength(100)
            .setPlaceholder('e.g. token, note, snippet')
        )
      )
  )
}

export async function handleMessageStoreModal(interaction: ModalSubmitInteraction) {
  const key = interaction.fields.getTextInputValue(MESSAGE_STORE_KEY_INPUT_ID).trim()
  if (!key) {
    const payload = storeReply('No key provided.')
    await interaction.reply(payload)
    const message = (await interaction.fetchReply()) as { id?: string }
    if (typeof message.id === 'string') {
      scheduleEphemeralReplyDelete(interaction, message.id, payload.flags)
    }
    return
  }

  const content = getStoredValue(pendingKey(interaction.user.id))
  if (!content) {
    const payload = storeReply('No pending message found.')
    await interaction.reply(payload)
    const message = (await interaction.fetchReply()) as { id?: string }
    if (typeof message.id === 'string') {
      scheduleEphemeralReplyDelete(interaction, message.id, payload.flags)
    }
    return
  }

  setStoredValue(key, content)

  const preview = `${key}=${content.length > 200 ? content.slice(0, 200) + '...' : content}`
  const payload = storeReply(`**Stored**\n\`${preview}\``)
  await interaction.reply(payload)
  const message = (await interaction.fetchReply()) as { id?: string }
  if (typeof message.id === 'string') {
    scheduleEphemeralReplyDelete(interaction, message.id, payload.flags)
  }
}
