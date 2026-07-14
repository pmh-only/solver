import type { Subcommand } from '../types.js'
import {
  commandReferenceReply,
  runRerunnableCommand,
  sendCommandReply,
  separator,
  summarySection,
  text
} from '../components.js'
import { whoisClient } from './_whois.js'

function formatWhois(result: Awaited<ReturnType<typeof whoisClient.lookup>>) {
  const lines =
    result.fields.length > 0 ? result.fields : result.raw.split('\n').filter(Boolean).slice(0, 12)
  const rdapUrl = `https://rdap.org/domain/${encodeURIComponent(result.query)}`

  return [
    summarySection(
      `Whois ${result.query}`,
      [
        `-# server: ${result.server}`,
        ...(result.referral && result.referral !== result.server
          ? [`-# referral: ${result.referral}`]
          : [])
      ],
      { label: 'RDAP', url: rdapUrl }
    ),
    separator(),
    text(['**Key records**', ...lines.map((line) => `- ${line}`)].join('\n'))
  ]
}

export const subcommand: Subcommand = {
  name: 'whois',
  description: 'whois',
  usage: 'whois <domain> [--pub]',
  examples: ['whois example.com', 'whois discord.com'],
  pubtab: { label: 'Whois', args: 'example.com' },

  async run(args) {
    const restArgs = args.replace(/^\S+\s*/, '').trim()
    const result = await whoisClient.lookup(restArgs)
    return formatWhois(result)
  },

  async execute(interaction, args, flags) {
    const restArgs = args.replace(/^\S+\s*/, '').trim()

    if (!restArgs) {
      await sendCommandReply(
        interaction,
        commandReferenceReply(subcommand, args, flags, 'usage', 'no dom')
      )
      return
    }

    await runRerunnableCommand(interaction, subcommand, args, flags, async () =>
      subcommand.run!(args, flags)
    )
  }
}
