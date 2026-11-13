import type {
  InteractionEditReplyOptions,
  InteractionReplyOptions,
  RepliableInteraction
} from 'discord.js'

export type ReplyMode = 'command' | 'response' | 'reply' | 'edit' | 'update' | 'followUp'

/** Delivery only: callers own rendering, retention and command-input persistence. */
export async function deliverInteractionReply(
  interaction: RepliableInteraction,
  payload: { initial: InteractionReplyOptions; edit: InteractionEditReplyOptions },
  mode: ReplyMode = 'command',
  fetchMessage = false
): Promise<{ messageId?: string; followUp: boolean }> {
  if (mode === 'command' || mode === 'response') {
    if (interaction.deferred) mode = 'edit'
    else if (interaction.replied) mode = 'followUp'
    else if (mode === 'command' && (interaction.isButton() || interaction.isStringSelectMenu()))
      mode = 'update'
    else if (mode === 'command' && interaction.isModalSubmit() && interaction.isFromMessage()) {
      await interaction.deferUpdate()
      mode = 'edit'
    } else mode = 'reply'
  }

  let message: { id?: string } | undefined
  if (mode === 'edit') {
    message = await interaction.editReply(payload.edit)
  } else if (mode === 'followUp') {
    message = await interaction.followUp(payload.initial)
  } else if (mode === 'update') {
    if (!interaction.isMessageComponent()) throw new Error('Only components can update a message')
    await interaction.update(payload.edit)
    message = interaction.message
  } else {
    await interaction.reply(payload.initial)
    if (fetchMessage) message = await interaction.fetchReply()
  }
  return { messageId: message?.id, followUp: mode === 'followUp' }
}
