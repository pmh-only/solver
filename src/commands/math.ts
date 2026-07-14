import type { Subcommand } from '../types.js'
import {
  commandContainer,
  commandReferenceReply,
  sendCommandReply,
  separator,
  summarySection,
  text
} from '../components.js'
import { evaluateMathString } from './math_core.js'

export const subcommand: Subcommand = {
  name: 'math',
  description: 'do math',
  usage: 'math <expression> [--pub]',
  examples: ['math 2*(3+4)', 'math sqrt(144)+cos(0)', 'math max(1,2,3)^2'],
  pubtab: { label: 'Math', args: '2*(3+4)' },

  async execute(interaction, args, flags) {
    const restArgs = args.replace(/^\S+\s*/, '').trim()

    if (!restArgs) {
      await sendCommandReply(
        interaction,
        commandReferenceReply(subcommand, args, flags, 'usage', 'no expr')
      )
      return
    }

    try {
      const result = evaluateMathString(restArgs)
      await sendCommandReply(
        interaction,
        commandContainer(
          subcommand,
          args,
          flags,
          summarySection('Math result', ['Expression evaluated successfully']),
          separator(),
          text(`**Expression**\n\`${restArgs}\``),
          text(`**Result**\n\`${result}\``)
        )
      )
    } catch (error) {
      const message = error instanceof Error ? error.message : 'math err'
      await sendCommandReply(
        interaction,
        commandReferenceReply(subcommand, args, flags, 'usage', message)
      )
    }
  }
}
