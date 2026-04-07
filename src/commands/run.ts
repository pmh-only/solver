import type { Subcommand } from '../types.js'
import { container } from '../components.js'
import { evaluateJavaScript } from '../helpers/run_eval.js'

export const subcommand: Subcommand = {
  name: 'run',
  description: 'run js',

  async execute(interaction, args, flags) {
    const restArgs = args.replace(/^\S+\s*/, '').trim()

    if (!restArgs) {
      await interaction.reply(container(args, flags, 'no code'))
      return
    }

    const evaluation = evaluateJavaScript(restArgs)
    await interaction.reply(container(args, flags, evaluation.output))
  }
}
