import type { Subcommand } from '../types.js'
import { container } from '../components.js'
import { evaluateMathString } from './math_core.js'

export const subcommand: Subcommand = {
  name: 'math',
  description: 'do math',

  async execute(interaction, args, flags) {
    const restArgs = args.replace(/^\S+\s*/, '').trim()

    if (!restArgs) {
      await interaction.reply(container(args, flags, 'no expr'))
      return
    }

    try {
      await interaction.reply(container(args, flags, evaluateMathString(restArgs)))
    } catch (error) {
      const message = error instanceof Error ? error.message : 'math err'
      await interaction.reply(container(args, flags, message))
    }
  }
}
