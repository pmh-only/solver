import type { Subcommand } from '../types.js'
import { container, runRerunnableCommand } from '../components.js'
import { whoisClient } from './_whois.js'

function formatWhois(result: Awaited<ReturnType<typeof whoisClient.lookup>>): string {
  const lines =
    result.fields.length > 0 ? result.fields : result.raw.split('\n').filter(Boolean).slice(0, 12)
  return [`**WHOIS ${result.query}**`, `-# srv: ${result.server}`, ...lines].join('\n')
}

export const subcommand: Subcommand = {
  name: 'whois',
  description: 'whois',

  async run(args) {
    const restArgs = args.replace(/^\S+\s*/, '').trim()
    const result = await whoisClient.lookup(restArgs)
    return formatWhois(result)
  },

  async execute(interaction, args, flags) {
    const restArgs = args.replace(/^\S+\s*/, '').trim()

    if (!restArgs) {
      await interaction.reply(container(args, flags, 'no dom'))
      return
    }

    await runRerunnableCommand(interaction, args, flags, async () => subcommand.run!(args, flags))
  }
}
