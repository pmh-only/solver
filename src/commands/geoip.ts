import type { Subcommand } from '../types.js'
import {
  commandReferenceReply,
  runRerunnableCommand,
  sendCommandReply,
  separator,
  summarySection,
  text
} from '../components.js'
import { geoIpClient } from './_geoip.js'

function mapUrl(latitude?: number, longitude?: number): string | null {
  if (typeof latitude !== 'number' || typeof longitude !== 'number') return null
  return `https://www.google.com/maps?q=${latitude},${longitude}`
}

function formatGeoIp(result: Awaited<ReturnType<typeof geoIpClient.lookup>>) {
  const location = [result.city, result.region, result.country, result.countryCode]
    .filter(Boolean)
    .join(', ')
  const coords =
    typeof result.latitude === 'number' && typeof result.longitude === 'number'
      ? `${result.latitude}, ${result.longitude}`
      : null

  return [
    summarySection(
      `GeoIP ${result.ip}`,
      [
        ...(location ? [`-# location: ${location}`] : []),
        ...(result.continent ? [`-# continent: ${result.continent}`] : []),
        '-# source: ipwho.is'
      ],
      mapUrl(result.latitude, result.longitude)
        ? { label: 'Open map', url: mapUrl(result.latitude, result.longitude)! }
        : undefined
    ),
    separator(),
    text(
      [
        '**Coordinates**',
        ...(coords ? [`-# gps: ${coords}`] : ['-# gps: unavailable']),
        ...(result.timezone ? [`-# timezone: ${result.timezone}`] : [])
      ].join('\n')
    ),
    text(
      [
        '**Network**',
        ...(result.asn ? [`-# asn: ${result.asn}`] : []),
        ...(result.org ? [`-# org: ${result.org}`] : []),
        ...(result.isp ? [`-# isp: ${result.isp}`] : []),
        ...(!result.asn && !result.org && !result.isp ? ['-# none'] : [])
      ].join('\n')
    )
  ]
}

export const subcommand: Subcommand = {
  name: 'geoip',
  description: 'geo ip',
  usage: 'geoip <ip> [--pub]',
  examples: ['geoip 1.1.1.1', 'geoip 8.8.8.8'],

  async run(args) {
    const restArgs = args.replace(/^\S+\s*/, '').trim()
    const result = await geoIpClient.lookup(restArgs)
    return formatGeoIp(result)
  },

  async execute(interaction, args, flags) {
    const restArgs = args.replace(/^\S+\s*/, '').trim()

    if (!restArgs) {
      await sendCommandReply(
        interaction,
        commandReferenceReply(subcommand, args, flags, 'usage', 'no ip')
      )
      return
    }

    await runRerunnableCommand(interaction, subcommand, args, flags, async () =>
      subcommand.run!(args, flags)
    )
  }
}
