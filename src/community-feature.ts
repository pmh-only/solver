import { type ChatInputCommandInteraction, type Interaction } from 'discord.js'
import type { DiscordFeature } from './feature-registry.js'
import type { Flags } from './flags.js'
import { markStandaloneContext } from './flags.js'
import { communityApplicationCommands } from './community-application-commands.js'
import { leisureCommands } from './commands/community-leisure.js'
import {
  guildCommunityCommands,
  handleCommunityConfirm,
  isCommunityConfirmId,
  sendCommunityNotice
} from './commands/community-guild.js'
import {
  subcommand as kickvote,
  handleKickvoteButton,
  isKickvoteButtonId
} from './commands/kickvote.js'
import { createHelpSubcommand } from './commands/help.js'
import { errorContainer, scheduleEphemeralMessageDelete, sendCommandReply } from './components.js'
import { safeErrorMessage } from './safe-error.js'

const commands = [...leisureCommands, ...guildCommunityCommands, kickvote]
commands.push(createHelpSubcommand(commands))
const byName = new Map(commands.map((command) => [command.name, command]))
const names = new Set(communityApplicationCommands.map((command) => command.name))

function commandArgs(interaction: ChatInputCommandInteraction): string {
  const options = interaction.options
  switch (interaction.commandName) {
    case 'food':
    case 'foods':
    case '점메추':
    case '저메추':
      return options.getString('filter') ?? ''
    case 'date':
      return options.getUser('member')?.id ?? ''
    case 'color':
      return [options.getString('hex', true), options.getString('secondary')]
        .filter(Boolean)
        .join(' ')
    case 'anon':
      return options.getString('message', true)
    case 'emoji': {
      const image = options.getAttachment('image', true)
      if (image.size > 1024 * 1024) throw new Error('이미지는 1 MiB 이하만 지원합니다.')
      return `${options.getString('name', true)} ${image.url}`
    }
    case 'kickvote':
      return `${options.getUser('user', true).id} ${options.getString('reason', true)}`
    case 'help':
      return options.getString('command') ?? ''
    default:
      return ''
  }
}

export function createCommunityFeature(): DiscordFeature {
  return {
    id: 'community',
    priority: 50,
    commands: communityApplicationCommands,
    matches(interaction) {
      return (
        ((interaction.isChatInputCommand() || interaction.isAutocomplete()) &&
          names.has(interaction.commandName)) ||
        (interaction.isButton() &&
          (isCommunityConfirmId(interaction.customId) || isKickvoteButtonId(interaction.customId)))
      )
    },
    async handle(interaction: Interaction) {
      try {
        if (!interaction.guildId) throw new Error('서버에서만 사용할 수 있습니다.')
        if (interaction.isAutocomplete()) {
          const focused = String(interaction.options.getFocused())
          const choices =
            interaction.commandName === 'help'
              ? [...names]
                  .filter((name) => name.startsWith(focused))
                  .slice(0, 25)
                  .map((name) => ({ name, value: name }))
              : []
          await interaction.respond(choices)
          return
        }
        if (interaction.isButton()) {
          if (isCommunityConfirmId(interaction.customId)) await handleCommunityConfirm(interaction)
          else await handleKickvoteButton(interaction)
          return
        }
        if (!interaction.isChatInputCommand()) return
        const command = byName.get(interaction.commandName)!
        const flags: Flags = new Map()
        if (!['invite', 'anon'].includes(interaction.commandName)) flags.set('pub', true)
        markStandaloneContext(flags)
        // Typed Discord options are not shell flags. Preserve message text such as "--pub" verbatim.
        await command.execute(
          interaction,
          `${command.name} ${commandArgs(interaction)}`.trim(),
          flags
        )
      } catch (error) {
        if (interaction.isAutocomplete()) {
          await interaction.respond([])
          return
        }
        if (!interaction.isRepliable()) return
        const message = safeErrorMessage(error).slice(0, 300)
        if (interaction.isButton() && !interaction.deferred && !interaction.replied) {
          await sendCommunityNotice(interaction, message)
          return
        }
        const payload = errorContainer('community', new Map(), message)
        if (interaction.replied) {
          const notice = await interaction.followUp(payload)
          if (typeof notice.id === 'string')
            scheduleEphemeralMessageDelete(interaction.webhook, notice.id, payload.flags)
        } else if (interaction.isChatInputCommand() || interaction.isButton()) {
          await sendCommandReply(interaction, payload)
        }
      }
    }
  }
}
