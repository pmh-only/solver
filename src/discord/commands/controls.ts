import {
  AttachmentBuilder,
  ComponentType,
  MessageFlags,
  type ButtonInteraction,
  type Collection,
  type Interaction
} from 'discord.js'
import type { InteractionRecovery, Subcommand } from './types.js'
import {
  buildEditParametersModal,
  buildConstrainedCommandInput,
  buildConstrainedCommandModal,
  cancelEphemeralDelete,
  COMMAND_ACTION_SELECT_ID,
  COMMAND_PRESET_SELECT_ID,
  container,
  commandReferenceReply,
  loadContentPublishValue,
  pinnedMessageComponents,
  sendCommandReply,
  EDIT_PARAMETERS_BUTTON_ID,
  EDIT_PARAMETERS_INPUT_ID,
  EDIT_PARAMETERS_MODAL_ID,
  COMMAND_RUN_BUTTON_ID,
  COMMAND_RUN_INPUT_ID,
  COMMAND_RUN_MODAL_ID,
  extractCommandInputFromMessage,
  loadConstrainedCommandTemplate,
  matchesInteractiveId,
  PIN_BUTTON_ID,
  PUB_BUTTON_ID,
  PUB_CONTENT_BUTTON_ID,
  PUBTAB_BUTTON_ID,
  RETRY_BUTTON_ID
} from '../ui/components.js'
import { resolveCommandInput, runCommandInput } from './input.js'

async function publishedPayload(interaction: ButtonInteraction) {
  const files = await Promise.all(
    [...interaction.message.attachments.values()].map(async (attachment) => {
      if (!attachment.name) throw new Error('attachment has no name')
      const response = await fetch(attachment.url, { signal: AbortSignal.timeout(5_000) })
      if (!response.ok) throw new Error(`attachment download failed: ${response.status}`)
      return new AttachmentBuilder(Buffer.from(await response.arrayBuffer()), {
        name: attachment.name,
        description: attachment.description ?? undefined
      })
    })
  )
  const components = interaction.message.components.flatMap((component) => {
    const json = component.toJSON()
    return json.type === ComponentType.ActionRow ? [] : [json]
  })
  return { components, files }
}

export async function handleCommandControls(
  interaction: Interaction,
  subcommands: Collection<string, Subcommand>,
  recover?: InteractionRecovery
): Promise<boolean> {
  if (interaction.isButton()) {
    if (interaction.customId === PUBTAB_BUTTON_ID) {
      const pubtab = subcommands.get('pubtab')
      if (!pubtab) await interaction.reply(container('pubtab', new Map(), 'no cmd'))
      else await pubtab.execute(interaction, 'pubtab', new Map())
      return true
    }
    if (interaction.customId === PIN_BUTTON_ID) {
      cancelEphemeralDelete(interaction.message.id)
      const components = pinnedMessageComponents(interaction.message.components) as never
      const v2 = interaction.message.components.some(
        (component) => component.toJSON().type !== ComponentType.ActionRow
      )
      await interaction.update({
        components,
        ...(v2 ? { flags: MessageFlags.IsComponentsV2 } : {})
      })
      return true
    }
    if (interaction.customId === PUB_BUTTON_ID) {
      await interaction.deferReply()
      try {
        const payload = await publishedPayload(interaction)
        await interaction.editReply({
          ...payload,
          attachments: [],
          flags: MessageFlags.IsComponentsV2
        })
      } catch {
        await sendCommandReply(
          interaction,
          container('pub', new Map([['pub', true]]), 'could not copy attachment')
        )
      }
      return true
    }
    if (interaction.customId.startsWith(`${PUB_CONTENT_BUTTON_ID}:`)) {
      const content = loadContentPublishValue(interaction.customId)
      await interaction.reply(content ? { content } : container('pub', new Map(), 'no content'))
      return true
    }
    if (matchesInteractiveId(interaction.customId, RETRY_BUTTON_ID)) {
      const commandInput = extractCommandInputFromMessage(interaction)
      if (!commandInput) await interaction.reply(container('retry', new Map(), 'no cmd'))
      else await runCommandInput(interaction, subcommands, commandInput, false, recover)
      return true
    }
    if (matchesInteractiveId(interaction.customId, COMMAND_RUN_BUTTON_ID)) {
      const template = loadConstrainedCommandTemplate(interaction.customId)
      if (!template) await interaction.reply(container('pubtab', new Map(), 'no cmd'))
      else if (subcommands.get(template.command)?.pubtab?.direct) {
        await runCommandInput(
          interaction,
          subcommands,
          buildConstrainedCommandInput(template, template.args || '--null'),
          true,
          recover
        )
      } else
        await interaction.showModal(buildConstrainedCommandModal(interaction.customId, template))
      return true
    }
    if (matchesInteractiveId(interaction.customId, EDIT_PARAMETERS_BUTTON_ID)) {
      const commandInput = extractCommandInputFromMessage(interaction)
      if (!commandInput) await interaction.reply(container('edit', new Map(), 'no cmd'))
      else await interaction.showModal(buildEditParametersModal(commandInput))
      return true
    }
  }
  if (interaction.isStringSelectMenu()) {
    if (interaction.customId === COMMAND_PRESET_SELECT_ID) {
      const preset = interaction.values[0]
      if (!preset) await sendCommandReply(interaction, container('preset', new Map(), 'no cmd'))
      else await interaction.showModal(buildEditParametersModal(preset))
      return true
    }
    if (matchesInteractiveId(interaction.customId, COMMAND_ACTION_SELECT_ID)) {
      const commandInput = extractCommandInputFromMessage(interaction)
      if (!commandInput) {
        await sendCommandReply(interaction, container('help', new Map(), 'no cmd'))
        return true
      }
      const { bare, flags, sub } = resolveCommandInput(commandInput, subcommands)
      if (!sub) {
        await sendCommandReply(interaction, container(bare || 'help', flags, 'no cmd'))
        return true
      }
      const view = interaction.values[0]
      if (view === 'usage' || view === 'examples' || view === 'flags') {
        await sendCommandReply(interaction, commandReferenceReply(sub, bare, flags, view))
      }
      return true
    }
  }
  if (interaction.isModalSubmit()) {
    if (interaction.customId === EDIT_PARAMETERS_MODAL_ID) {
      await runCommandInput(
        interaction,
        subcommands,
        interaction.fields.getTextInputValue(EDIT_PARAMETERS_INPUT_ID),
        false,
        recover
      )
      return true
    }
    if (interaction.customId.startsWith(`${COMMAND_RUN_MODAL_ID}:`)) {
      const template = loadConstrainedCommandTemplate(interaction.customId)
      if (!template) {
        await interaction.reply(container('pubtab', new Map(), 'no cmd'))
        return true
      }
      const commandInput = buildConstrainedCommandInput(
        template,
        interaction.fields.getTextInputValue(COMMAND_RUN_INPUT_ID)
      )
      await interaction.deferReply()
      await runCommandInput(interaction, subcommands, commandInput, true, recover)
      return true
    }
  }
  return false
}
