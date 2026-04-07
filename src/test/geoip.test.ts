import { describe, it, expect, vi, afterEach } from 'vitest'
import { InteractionResponseType, MessageFlags } from 'discord.js'
import { subcommand as geoip } from '../commands/geoip.js'
import { geoIpClient } from '../commands/_geoip.js'
import {
  autocompleteJSON,
  commandJSON,
  dispatch,
  getCallback,
  getEdit,
  makeSubcommands
} from './e2e.js'

const subs = makeSubcommands(geoip)

afterEach(() => {
  vi.restoreAllMocks()
})

describe('geoip — command', () => {
  it('replies immediately with usage when no IP given', async () => {
    const calls = await dispatch(commandJSON('geoip'), subs)
    const body = getCallback(calls) as { type: number; data: { flags: number } }

    expect(body.type).toBe(InteractionResponseType.ChannelMessageWithSource)
    expect(body.data.flags & MessageFlags.Ephemeral).toBeTruthy()
  })

  it('defers then edits when IP given', async () => {
    vi.spyOn(geoIpClient, 'lookup').mockResolvedValue({
      ip: '12.34.56.78',
      city: 'Seoul',
      region: 'Seoul',
      country: 'South Korea',
      countryCode: 'KR',
      continent: 'Asia',
      latitude: 37.5665,
      longitude: 126.978,
      timezone: 'Asia/Seoul',
      asn: 'AS64500',
      org: 'Example Org',
      isp: 'Example ISP'
    })

    const calls = await dispatch(commandJSON('geoip 12.34.56.78'), subs)
    const defer = getCallback(calls) as { type: number; data: { flags: number } }
    const edit = getEdit(calls) as { components: unknown[] }

    expect(defer.type).toBe(InteractionResponseType.DeferredChannelMessageWithSource)
    expect(edit.components).toBeDefined()
  })

  it('defers publicly with --pub', async () => {
    vi.spyOn(geoIpClient, 'lookup').mockResolvedValue({
      ip: '12.34.56.78',
      country: 'South Korea'
    })

    const calls = await dispatch(commandJSON('geoip 12.34.56.78 --pub'), subs)
    const defer = getCallback(calls) as { type: number; data: { flags: number } }

    expect(defer.type).toBe(InteractionResponseType.DeferredChannelMessageWithSource)
    expect(defer.data.flags & MessageFlags.Ephemeral).toBeFalsy()
  })
})

describe('geoip — autocomplete', () => {
  it('returns geoip in selection mode', async () => {
    const calls = await dispatch(autocompleteJSON('ge'), subs)
    const body = getCallback(calls) as { type: number; data: { choices: { value: string }[] } }

    expect(body.type).toBe(InteractionResponseType.ApplicationCommandAutocompleteResult)
    expect(body.data.choices.some((choice) => choice.value === 'geoip')).toBe(true)
  })
})
