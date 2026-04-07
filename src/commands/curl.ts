import type { Subcommand } from '../types.js'
import { container, runRerunnableCommand } from '../components.js'
import { executeCurl, parseCurlInvocation } from '../curl-runtime.js'

export const subcommand: Subcommand = {
  name: 'curl',
  description: 'web req',

  flags: {
    method: { description: 'method', value: 'string', alias: 'X' },
    header: { description: 'header', value: 'string', alias: 'H' },
    data: { description: 'body', value: 'string', alias: 'd' }
  },

  async run(args, flags) {
    const parsed = parseCurlInvocation(args, flags)
    if ('error' in parsed) {
      throw new Error(parsed.error)
    }

    return executeCurl(parsed)
  },

  async execute(interaction, args, flags) {
    const parsed = parseCurlInvocation(args, flags)
    if ('error' in parsed) {
      await interaction.reply(container(args, flags, parsed.error))
      return
    }

    await runRerunnableCommand(interaction, args, flags, async () => subcommand.run!(args, flags))
  }
}
