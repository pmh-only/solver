import type { Subcommand } from '../types.js'
import {
  commandReferenceReply,
  runRerunnableCommand,
  sendCommandReply,
  separator,
  summarySection,
  text
} from '../components.js'
import { dnsClient } from './_dns.js'

function parseQuery(input: string): { name: string; type?: string } {
  const [name, type] = input.trim().split(/\s+/, 2)
  if (!name) throw new Error('no host')
  return { name, type }
}

function formatSection(
  title: string,
  records: Awaited<ReturnType<typeof dnsClient.lookup>>['answers']
): string {
  return [
    `**${title}**`,
    ...(records.length > 0
      ? records.map((record) => `-# ${record.name} ${record.ttl} IN ${record.type} ${record.data}`)
      : ['-# none'])
  ].join('\n')
}

function formatDig(result: Awaited<ReturnType<typeof dnsClient.lookup>>) {
  const sections = [
    summarySection(`Dig ${result.name}`, [
      `-# type: ${result.type}`,
      `-# server: ${result.server}`
    ]),
    separator(),
    text(formatSection('Answers', result.answers)),
    text(formatSection('Authority', result.authority)),
    text(formatSection('Additional', result.additional))
  ]

  if (
    result.answers.length === 0 &&
    result.authority.length === 0 &&
    result.additional.length === 0
  ) {
    sections[2] = text('**Answers**\n-# none')
  }

  return sections
}

export const subcommand: Subcommand = {
  name: 'dig',
  description: 'dns',
  usage: 'dig <name> [type] [--pub]',
  examples: ['dig example.com', 'dig example.com AAAA', 'dig _discord._tcp.example.com SRV'],
  pubtab: { label: 'DNS', args: 'example.com' },

  async run(args) {
    const restArgs = args.replace(/^\S+\s*/, '').trim()
    const query = parseQuery(restArgs)
    const result = await dnsClient.lookup(query.name, query.type)
    return formatDig(result)
  },

  async execute(interaction, args, flags) {
    const restArgs = args.replace(/^\S+\s*/, '').trim()

    if (!restArgs) {
      await sendCommandReply(
        interaction,
        commandReferenceReply(subcommand, args, flags, 'usage', 'no host')
      )
      return
    }

    parseQuery(restArgs)

    await runRerunnableCommand(interaction, subcommand, args, flags, async () =>
      subcommand.run!(args, flags)
    )
  }
}
