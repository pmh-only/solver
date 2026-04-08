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

export async function handleMessageStoreCommand(
  interaction: MessageContextMenuCommandInteraction
) {
  const content = interaction.targetMessage.content
  if (!content.trim()) {
    const payload = {
      components: [text('message has no text content'), pinButtonRow()],
      flags: [MessageFlags.IsComponentsV2, MessageFlags.Ephemeral] as const
    }
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
    const payload = {
      components: [text('no key provided'), pinButtonRow()],
      flags: [MessageFlags.IsComponentsV2, MessageFlags.Ephemeral] as const
    }
    await interaction.reply(payload)
    const message = (await interaction.fetchReply()) as { id?: string }
    if (typeof message.id === 'string') {
      scheduleEphemeralReplyDelete(interaction, message.id, payload.flags)
    }
    return
  }

  const content = getStoredValue(pendingKey(interaction.user.id))
  if (!content) {
    const payload = {
      components: [text('no pending message found'), pinButtonRow()],
      flags: [MessageFlags.IsComponentsV2, MessageFlags.Ephemeral] as const
    }
    await interaction.reply(payload)
    const message = (await interaction.fetchReply()) as { id?: string }
    if (typeof message.id === 'string') {
      scheduleEphemeralReplyDelete(interaction, message.id, payload.flags)
    }
    return
  }

  setStoredValue(key, content)

  const payload = {
    components: [text(`**Stored**\n\`${key}=${content.length > 200 ? content.slice(0, 200) + '...' : content}\``), pinButtonRow()],
    flags: [MessageFlags.IsComponentsV2, MessageFlags.Ephemeral] as const
  }
  await interaction.reply(payload)
  const message = (await interaction.fetchReply()) as { id?: string }
  if (typeof message.id === 'string') {
    scheduleEphemeralReplyDelete(interaction, message.id, payload.flags)
  }
}
