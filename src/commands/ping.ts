import type { Subcommand } from '../types.js'
import {
  commandContainer,
  commandReferenceReply,
  runRerunnableCommand,
  sendCommandReply,
  separator,
  summarySection,
  text
} from '../components.js'
import { DEFAULT_PING_COUNT, parsePingTypes, probePingTarget } from '../ping-runtime.js'

function shiftLeadingToken(input: string): { token?: string; rest: string } {
  const trimmed = input.trim()
  if (!trimmed) return { rest: '' }

  const [token, ...rest] = trimmed.split(/\s+/)
  return { token, rest: rest.join(' ') }
}

function parseCount(value: string | true | undefined): number {
  if (typeof value !== 'string') return DEFAULT_PING_COUNT
  const parsed = Number.parseInt(value, 10)
  if (!Number.isFinite(parsed) || parsed < 1) return DEFAULT_PING_COUNT
  return Math.min(parsed, 10)
}

function formatMs(value: number): string {
  return `${value.toFixed(1)}ms`
}

function hostUrl(host: string): string | null {
  try {
    return new URL(host.includes('://') ? host : `https://${host}`).toString()
  } catch {
    return null
  }
}

function buildPingComponents(report: Awaited<ReturnType<typeof probePingTarget>>) {
  const components = [
    summarySection(
      `Ping ${report.host}`,
      [`${report.count} probe${report.count === 1 ? '' : 's'} across ${report.types.join(', ')}`],
      hostUrl(report.host) ? { label: 'Open host', url: hostUrl(report.host)! } : undefined
    ),
    separator()
  ]

  for (const summary of report.summaries) {
    if (summary.note && summary.ms.length === 0) {
      components.push(text(`**${summary.type.toUpperCase()}**\n-# ${summary.note}`))
      continue
    }

    if (summary.ms.length === 0) {
      components.push(text(`**${summary.type.toUpperCase()}**\n-# ${summary.error ?? 'err'}`))
      continue
    }

    const min = Math.min(...summary.ms)
    const avg = summary.ms.reduce((total, value) => total + value, 0) / summary.ms.length
    const max = Math.max(...summary.ms)
    const loss =
      summary.ms.length < summary.count
        ? `${summary.count - summary.ms.length}/${summary.count}`
        : '0'
    const note = summary.note ? `\n-# note: ${summary.note}` : ''

    components.push(
      text(
        [
          `**${summary.type.toUpperCase()}**`,
          `-# min ${formatMs(min)}`,
          `-# avg ${formatMs(avg)}`,
          `-# max ${formatMs(max)}`,
          `-# loss ${loss}`
        ].join('\n') + note
      )
    )
  }

  return components
}

export const subcommand: Subcommand = {
  name: 'ping',
  description: 'probe host',
  usage: 'ping <host> [--count <1-10>] [--type <icmp,http,https,http3>] [--pub]',
  examples: ['ping 1.1.1.1', 'ping example.com --count 5', 'ping example.com --type https,http3'],
  pubtab: { label: 'Ping', args: '1.1.1.1' },

  flags: {
    ip: { description: 'host', value: 'string' },
    count: { description: 'count', value: 'string', alias: 'c' },
    type: {
      description: 'types',
      value: 'string',
      alias: 't'
    }
  },

  async run(args, flags) {
    let restArgs = args.replace(/^\S+\s*/, '').trim()
    let countFlag = flags.get('count')
    let typeFlag = flags.get('type')

    if (countFlag === true) {
      const shifted = shiftLeadingToken(restArgs)
      countFlag = shifted.token
      restArgs = shifted.rest
    }

    if (typeFlag === true) {
      const shifted = shiftLeadingToken(restArgs)
      typeFlag = shifted.token
      restArgs = shifted.rest
    }

    const host = (flags.get('ip') as string | undefined) ?? restArgs
    const types = parsePingTypes(typeof typeFlag === 'string' ? typeFlag : undefined)
    if ('error' in types) {
      throw new Error(types.error)
    }

    const report = await probePingTarget({
      host,
      count: parseCount(countFlag),
      types
    })

    return buildPingComponents(report)
  },

  async execute(interaction, args, flags) {
    let restArgs = args.replace(/^\S+\s*/, '').trim()
    const countFlag = flags.get('count')
    let typeFlag = flags.get('type')

    if (countFlag === true) {
      const shifted = shiftLeadingToken(restArgs)
      restArgs = shifted.rest
    }

    if (typeFlag === true) {
      const shifted = shiftLeadingToken(restArgs)
      typeFlag = shifted.token
      restArgs = shifted.rest
    }

    const host = (flags.get('ip') as string | undefined) ?? restArgs

    if (!host) {
      const latency = Date.now() - interaction.createdTimestamp
      await sendCommandReply(
        interaction,
        commandContainer(
          subcommand,
          args,
          flags,
          summarySection('Ping', [
            `pong: ${latency < 1 ? '< 1' : latency}ms`,
            'Add a host to probe HTTP, HTTPS, and HTTP/3 reachability.'
          ])
        )
      )
      return
    }

    const types = parsePingTypes(typeof typeFlag === 'string' ? typeFlag : undefined)
    if ('error' in types) {
      await sendCommandReply(
        interaction,
        commandReferenceReply(subcommand, args, flags, 'flags', types.error)
      )
      return
    }

    await runRerunnableCommand(interaction, subcommand, args, flags, async () => {
      return subcommand.run!(args, flags)
    })
  }
}
