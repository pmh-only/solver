import type { Subcommand } from '../types.js'
import { container, runRerunnableCommand } from '../components.js'
import { geoIpClient } from './_geoip.js'

function formatGeoIp(result: Awaited<ReturnType<typeof geoIpClient.lookup>>): string {
  const location = [result.city, result.region, result.country, result.countryCode]
    .filter(Boolean)
    .join(', ')
  const coords =
    typeof result.latitude === 'number' && typeof result.longitude === 'number'
      ? `${result.latitude}, ${result.longitude}`
      : null

  return [
    `**GEOIP ${result.ip}**`,
    location ? `-# loc: ${location}` : null,
    result.continent ? `-# cont: ${result.continent}` : null,
    coords ? `-# gps: ${coords}` : null,
    result.timezone ? `-# tz: ${result.timezone}` : null,
    result.asn || result.org || result.isp
      ? `-# net: ${[result.asn, result.org, result.isp].filter(Boolean).join(' | ')}`
      : null,
    '-# src: ipwho.is'
  ]
    .filter((line): line is string => Boolean(line))
    .join('\n')
}

export const subcommand: Subcommand = {
  name: 'geoip',
  description: 'geo ip',

  async run(args) {
    const restArgs = args.replace(/^\S+\s*/, '').trim()
    const result = await geoIpClient.lookup(restArgs)
    return formatGeoIp(result)
  },

  async execute(interaction, args, flags) {
    const restArgs = args.replace(/^\S+\s*/, '').trim()

    if (!restArgs) {
      await interaction.reply(container(args, flags, 'no ip'))
      return
    }

    await runRerunnableCommand(interaction, args, flags, async () => subcommand.run!(args, flags))
  }
}
