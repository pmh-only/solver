import type { Subcommand } from '../types.js'
import {
  codeBlock,
  commandContainer,
  commandReferenceReply,
  sendCommandReply,
  separator,
  summarySection
} from '../components.js'
import { evaluateJavaScript } from '../helpers/run_eval.js'

function trimSource(source: string): string {
  return source.length > 1200 ? `${source.slice(0, 1186)}\n... truncated` : source
}

export const subcommand: Subcommand = {
  name: 'run',
  description: 'run js',
  usage: 'run <javascript> [--pub]',
  examples: ['run [1,2,3].map((x) => x * 2)', 'run console.log("hi"); Math.PI'],

  async execute(interaction, args, flags) {
    const restArgs = args.replace(/^\S+\s*/, '').trim()

    if (!restArgs) {
      await sendCommandReply(
        interaction,
        commandReferenceReply(subcommand, args, flags, 'usage', 'no code')
      )
      return
    }

    const evaluation = evaluateJavaScript(restArgs)
    await sendCommandReply(
      interaction,
      commandContainer(
        subcommand,
        args,
        flags,
        summarySection('JavaScript runtime', [
          evaluation.ok ? 'Execution completed' : 'Execution failed'
        ]),
        separator(),
        codeBlock('Source', trimSource(restArgs), 'js'),
        ...(evaluation.stdout ? [codeBlock('Console', evaluation.stdout)] : []),
        evaluation.ok
          ? codeBlock('Result', evaluation.result ?? 'undefined')
          : codeBlock('Error', evaluation.error ?? 'run err')
      )
    )
  }
}
