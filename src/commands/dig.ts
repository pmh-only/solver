import type { Subcommand } from '../types.js'
import { container, runRerunnableCommand } from '../components.js'
import { dnsClient } from './_dns.js'

function parseQuery(input: string): { name: string; type?: string } {
  const [name, type] = input.trim().split(/\s+/, 2)
  if (!name) throw new Error('no host')
  return { name, type }
}

function formatSection(
  title: string,
  records: Awaited<ReturnType<typeof dnsClient.lookup>>['answers']
): string[] {
  if (records.length === 0) return []
  return [
    `**${title}**`,
    ...records.map((record) => `-# ${record.name} ${record.ttl} IN ${record.type} ${record.data}`)
  ]
}

function formatDig(result: Awaited<ReturnType<typeof dnsClient.lookup>>): string {
  const sections = [
    `**DIG ${result.name} ${result.type}**`,
    `-# srv: ${result.server}`,
    ...formatSection('ANS', result.answers),
    ...formatSection('AUTH', result.authority),
    ...formatSection('ADD', result.additional)
  ]

  if (
    result.answers.length === 0 &&
    result.authority.length === 0 &&
    result.additional.length === 0
  ) {
    sections.push('-# none')
  }

  return sections.join('\n')
}

export const subcommand: Subcommand = {
  name: 'dig',
  description: 'dns',

  async run(args) {
    const restArgs = args.replace(/^\S+\s*/, '').trim()
    const query = parseQuery(restArgs)
    const result = await dnsClient.lookup(query.name, query.type)
    return formatDig(result)
  },

  async execute(interaction, args, flags) {
    const restArgs = args.replace(/^\S+\s*/, '').trim()

    if (!restArgs) {
      await interaction.reply(container(args, flags, 'no host'))
      return
    }

    parseQuery(restArgs)

    await runRerunnableCommand(interaction, args, flags, async () => subcommand.run!(args, flags))
  }
}
