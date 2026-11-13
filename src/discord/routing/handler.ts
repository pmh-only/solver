import { Collection, ComponentType, MessageFlags, type Interaction } from 'discord.js'
import type { InteractionRecovery, Subcommand } from '../commands/types.js'
import {
  COMMAND_RUN_BUTTON_ID,
  COMMAND_RUN_MODAL_ID,
  PUBTAB_BUTTON_ID,
  errorContainer,
  loadConstrainedCommandTemplate,
  matchesInteractiveId,
  sendCommandReply
} from '../ui/components.js'
import { resolveCommandInput, runCommandInput } from '../commands/input.js'
import { handleCommandAutocomplete } from '../commands/autocomplete.js'
import { handleCommandControls } from '../commands/controls.js'
import { handleFeatureInteraction } from './feature-interactions.js'
import { deliverInteractionReply } from '../ui/interaction-reply.js'
import {
  AGENT_COMMAND_NAME,
  handleAgentCommand,
  isAgentMcpRuntimeInitializing
} from '../../agent/index.js'
import { isFileconvModalId } from '../../features/media/convert/command.js'
import { isAdminUser } from '../../shared/security/authorization.js'

function hasPublicSourceMessage(interaction: Interaction): boolean {
  if (interaction.isMessageComponent())
    return !interaction.message.flags.has(MessageFlags.Ephemeral)
  if (interaction.isModalSubmit() && interaction.message)
    return !interaction.message.flags.has(MessageFlags.Ephemeral)
  return false
}

function isPubtabInteraction(
  interaction: Interaction,
  subcommands: Collection<string, Subcommand>
): boolean {
  if (interaction.isChatInputCommand() && interaction.commandName === 'c') {
    return (
      resolveCommandInput(interaction.options.getString('_', true), subcommands).subName ===
      'pubtab'
    )
  }
  if (interaction.isButton() && interaction.customId === PUBTAB_BUTTON_ID) return true
  if (
    (interaction.isButton() && matchesInteractiveId(interaction.customId, COMMAND_RUN_BUTTON_ID)) ||
    (interaction.isModalSubmit() && interaction.customId.startsWith(`${COMMAND_RUN_MODAL_ID}:`))
  ) {
    try {
      const template = loadConstrainedCommandTemplate(interaction.customId)
      return Boolean(template && subcommands.get(template.command)?.pubtab)
    } catch {
      return false
    }
  }
  if (
    interaction.isModalSubmit() &&
    isFileconvModalId(interaction.customId) &&
    interaction.customId.endsWith(':public')
  ) {
    return Boolean(subcommands.get('fileconv')?.pubtab)
  }
  return false
}

export function createHandler(
  subcommands: Collection<string, Subcommand>,
  recover?: InteractionRecovery
) {
  return async (interaction: Interaction): Promise<void> => {
    try {
      if (
        !isAdminUser(interaction.user.id) &&
        !hasPublicSourceMessage(interaction) &&
        !isPubtabInteraction(interaction, subcommands)
      ) {
        if (interaction.isAutocomplete()) await interaction.respond([])
        return
      }
      if (await handleFeatureInteraction(interaction)) return
      if (await handleCommandControls(interaction, subcommands, recover)) return
      if (interaction.isAutocomplete()) {
        await handleCommandAutocomplete(interaction, subcommands)
        return
      }
      if (!interaction.isChatInputCommand()) return
      if (interaction.commandName === AGENT_COMMAND_NAME) {
        if (isAgentMcpRuntimeInitializing()) {
          await interaction.reply({
            embeds: [],
            components: [
              {
                type: ComponentType.TextDisplay,
                content: 'MCP services are still starting. Try `/a` again shortly.'
              }
            ],
            flags: MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral,
            allowedMentions: { parse: [] }
          })
          return
        }
        await handleAgentCommand(interaction)
      } else if (interaction.commandName === 'c') {
        await runCommandInput(
          interaction,
          subcommands,
          interaction.options.getString('_', true),
          false,
          recover
        )
      }
    } catch (error) {
      console.error(error)
      if (interaction.isAutocomplete()) {
        if (!interaction.responded) await interaction.respond([])
        return
      }
      if (recover) {
        try {
          await recover(interaction, error, 'interaction router')
          return
        } catch (recoveryError) {
          console.error('interaction recovery failed', recoveryError)
        }
      }
      if (!('reply' in interaction)) return
      if (interaction.isChatInputCommand() && interaction.commandName === AGENT_COMMAND_NAME) {
        const message = error instanceof Error ? error.message : String(error)
        const reply = {
          embeds: [],
          components: [
            {
              type: ComponentType.TextDisplay as const,
              content: `error: ${message.slice(0, 3_900)}`
            }
          ],
          attachments: [],
          flags: MessageFlags.IsComponentsV2 as const,
          allowedMentions: { parse: [] as const }
        }
        await deliverInteractionReply(interaction, { initial: reply, edit: reply }, 'response')
        return
      }
      await sendCommandReply(interaction, errorContainer('err', new Map(), 'err'), 'response')
    }
  }
}
