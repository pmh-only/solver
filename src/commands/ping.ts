import type { Subcommand } from '../types.js'
import { container, runRerunnableCommand } from '../components.js'
import {
  DEFAULT_PING_COUNT,
  formatPingReport,
  parsePingTypes,
  probePingTarget
} from '../ping-runtime.js'

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

export const subcommand: Subcommand = {
  name: 'ping',
  description: 'probe host',

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

    return formatPingReport(report)
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
      await interaction.reply(container(args, flags, `pong: ${latency}ms`))
      return
    }

    const types = parsePingTypes(typeof typeFlag === 'string' ? typeFlag : undefined)
    if ('error' in types) {
      await interaction.reply(container(args, flags, types.error))
      return
    }

    await runRerunnableCommand(interaction, args, flags, async () => {
      return subcommand.run!(args, flags)
    })
  }
}
