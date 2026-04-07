import { MessageFlags } from 'discord.js'
import type { Subcommand } from '../types.js'
import { container } from '../components.js'
import { executeShell } from '../helpers/shell.js'

export const subcommand: Subcommand = {
  name: 'sh',
  description: 'run shell',

  async execute(interaction, args, flags) {
    const restArgs = args.replace(/^\S+\s*/, '').trim()

    if (!restArgs) {
      await interaction.reply(container(args, flags, 'no cmd'))
      return
    }

    await interaction.deferReply({ flags: flags.has('pub') ? undefined : MessageFlags.Ephemeral })
    const result = await executeShell(restArgs)
    const reply = container(args, flags, result.output)
    await interaction.editReply({
      components: reply.components,
      flags: MessageFlags.IsComponentsV2
    })
  }
}
