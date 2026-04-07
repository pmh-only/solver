import { MessageFlags } from 'discord.js'
import type { Subcommand } from '../types.js'
import { container } from '../components.js'
import { convertValue, inspectConvRequest } from './conv_core.js'

export const subcommand: Subcommand = {
  name: 'conv',
  description: 'convert',

  async execute(interaction, args, flags) {
    const restArgs = args.replace(/^\S+\s*/, '').trim()

    if (!restArgs) {
      await interaction.reply(container(args, flags, 'no args'))
      return
    }

    try {
      const request = inspectConvRequest(restArgs)

      if (request.kind === 'currency') {
        await interaction.deferReply({
          flags: flags.has('pub') ? undefined : MessageFlags.Ephemeral
        })
        const result = await convertValue(restArgs)
        const reply = container(args, flags, result)
        await interaction.editReply({
          components: reply.components,
          flags: MessageFlags.IsComponentsV2
        })
        return
      }

      const result = await convertValue(restArgs)
      await interaction.reply(container(args, flags, result))
    } catch (error) {
      const message = error instanceof Error ? error.message : 'conv err'
      await interaction.reply(container(args, flags, message))
    }
  }
}
