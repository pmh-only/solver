import type { Subcommand } from '../types.js'
import { container, runRerunnableCommand } from '../components.js'
import { certClient } from './_cert.js'

function formatMap(label: string, value: Record<string, string>): string | null {
  const pairs = Object.entries(value)
  if (pairs.length === 0) return null
  return `-# ${label}: ${pairs.map(([key, entry]) => `${key}=${entry}`).join(', ')}`
}

function formatCert(result: Awaited<ReturnType<typeof certClient.lookup>>): string {
  const lines = [
    `**CERT ${result.host}:${result.port}**`,
    formatMap('sub', result.subject),
    formatMap('iss', result.issuer),
    result.subjectAltName ? `-# san: ${result.subjectAltName}` : null,
    `-# exp: ${result.validFrom} -> ${result.validTo}`,
    `-# sn: ${result.serialNumber}`,
    result.fingerprint256 ? `-# sha: ${result.fingerprint256}` : null,
    `-# tls: ${result.protocol ?? 'none'}${result.cipher ? `, ${result.cipher}` : ''}`,
    `-# auth: ${result.authorized ? 'ok' : 'no'}`
  ]

  return lines.filter((line): line is string => Boolean(line)).join('\n')
}

export const subcommand: Subcommand = {
  name: 'cert',
  description: 'tls cert',

  async run(args) {
    const restArgs = args.replace(/^\S+\s*/, '').trim()
    const result = await certClient.lookup(restArgs)
    return formatCert(result)
  },

  async execute(interaction, args, flags) {
    const restArgs = args.replace(/^\S+\s*/, '').trim()

    if (!restArgs) {
      await interaction.reply(container(args, flags, 'no host'))
      return
    }

    await runRerunnableCommand(interaction, args, flags, async () => subcommand.run!(args, flags))
  }
}
