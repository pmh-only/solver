import type { Subcommand } from '../types.js'
import {
  codeBlock,
  commandReferenceReply,
  runRerunnableCommand,
  sendCommandReply,
  separator,
  summarySection,
  text
} from '../components.js'
import { executeShell } from '../helpers/shell.js'

function trimSource(source: string): string {
  return source.length > 1200 ? `${source.slice(0, 1186)}\n... truncated` : source
}

function formatShellResult(source: string, result: Awaited<ReturnType<typeof executeShell>>) {
  const summary = result.timedOut
    ? 'timeout'
    : result.ok
      ? 'Process exited successfully'
      : result.stderr
        ? 'Process finished with stderr output'
        : 'Process finished with errors'

  return [
    summarySection('Shell command', [summary]),
    separator(),
    codeBlock('Command', trimSource(source), 'sh'),
    ...(result.stdout ? [codeBlock('stdout', result.stdout)] : []),
    ...(result.stderr ? [codeBlock('stderr', result.stderr)] : []),
    text(
      `**Exit status**\n\`${
        result.exitCode === null
          ? result.timedOut
            ? 'timeout'
            : 'code unavailable'
          : `code ${result.exitCode}`
      }\``
    )
  ]
}

export const subcommand: Subcommand = {
  name: 'sh',
  description: 'run shell',
  usage: 'sh <command> [--pub]',
  examples: ['sh uname -a', 'sh dig discord.com'],

  async run(args) {
    const restArgs = args.replace(/^\S+\s*/, '').trim()
    const result = await executeShell(restArgs)
    return formatShellResult(restArgs, result)
  },

  async execute(interaction, args, flags) {
    const restArgs = args.replace(/^\S+\s*/, '').trim()

    if (!restArgs) {
      await sendCommandReply(
        interaction,
        commandReferenceReply(subcommand, args, flags, 'usage', 'no cmd')
      )
      return
    }

    await runRerunnableCommand(interaction, subcommand, args, flags, async () =>
      subcommand.run!(args, flags)
    )
  }
}
