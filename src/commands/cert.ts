import type { Subcommand } from '../types.js'
import {
  commandReferenceReply,
  keyValueBlock,
  runRerunnableCommand,
  sendCommandReply,
  separator,
  summarySection,
  text
} from '../components.js'
import { certClient } from './_cert.js'

function certUrl(host: string, port: number): string {
  return port === 443 ? `https://${host}` : `https://${host}:${port}`
}

function formatCert(result: Awaited<ReturnType<typeof certClient.lookup>>) {
  return [
    summarySection(
      `Certificate ${result.host}:${result.port}`,
      [
        `-# auth: ${result.authorized ? 'ok' : 'no'}`,
        `-# tls: ${result.protocol ?? 'none'}${result.cipher ? `, ${result.cipher}` : ''}`,
        ...(result.authorizationError ? [`-# verify: ${result.authorizationError}`] : [])
      ],
      { label: 'Open host', url: certUrl(result.host, result.port) }
    ),
    separator(),
    keyValueBlock('Subject', Object.entries(result.subject)),
    keyValueBlock('Issuer', Object.entries(result.issuer)),
    text(
      [
        '**Validity**',
        `-# from: ${result.validFrom}`,
        `-# to: ${result.validTo}`,
        `-# serial: ${result.serialNumber}`,
        ...(result.subjectAltName ? [`-# san: ${result.subjectAltName}`] : []),
        ...(result.fingerprint256 ? [`-# sha256: ${result.fingerprint256}`] : [])
      ].join('\n')
    )
  ]
}

export const subcommand: Subcommand = {
  name: 'cert',
  description: 'tls cert',
  usage: 'cert <host[:port]> [--pub]',
  examples: ['cert example.com', 'cert discord.com', 'cert example.com:8443'],
  pubtab: { label: 'TLS', args: 'example.com' },

  async run(args) {
    const restArgs = args.replace(/^\S+\s*/, '').trim()
    const result = await certClient.lookup(restArgs)
    return formatCert(result)
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

    await runRerunnableCommand(interaction, subcommand, args, flags, async () =>
      subcommand.run!(args, flags)
    )
  }
}
