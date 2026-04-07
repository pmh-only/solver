import { describe, it, expect, vi, afterEach } from 'vitest'
import { InteractionResponseType, MessageFlags } from 'discord.js'
import { subcommand as cert } from '../commands/cert.js'
import { certClient } from '../commands/_cert.js'
import {
  autocompleteJSON,
  commandJSON,
  dispatch,
  getCallback,
  getEdit,
  makeSubcommands
} from './e2e.js'

const subs = makeSubcommands(cert)

afterEach(() => {
  vi.restoreAllMocks()
})

describe('cert — command', () => {
  it('replies immediately with usage when no host given', async () => {
    const calls = await dispatch(commandJSON('cert'), subs)
    const body = getCallback(calls) as { type: number; data: { flags: number } }

    expect(body.type).toBe(InteractionResponseType.ChannelMessageWithSource)
    expect(body.data.flags & MessageFlags.Ephemeral).toBeTruthy()
  })

  it('defers then edits when host given', async () => {
    vi.spyOn(certClient, 'lookup').mockResolvedValue({
      host: 'google.com',
      port: 443,
      subject: { CN: 'google.com' },
      issuer: { CN: 'Google Trust Services' },
      subjectAltName: 'DNS:google.com, DNS:*.google.com',
      validFrom: 'Jan  1 00:00:00 2026 GMT',
      validTo: 'Jan  1 00:00:00 2027 GMT',
      serialNumber: '01',
      fingerprint256: 'AA:BB',
      authorized: true,
      authorizationError: null,
      protocol: 'TLSv1.3',
      cipher: 'TLS_AES_128_GCM_SHA256'
    })

    const calls = await dispatch(commandJSON('cert google.com'), subs)
    const defer = getCallback(calls) as { type: number; data: { flags: number } }
    const edit = getEdit(calls) as { components: unknown[] }

    expect(defer.type).toBe(InteractionResponseType.DeferredChannelMessageWithSource)
    expect(edit.components).toBeDefined()
  })

  it('defers publicly with --pub', async () => {
    vi.spyOn(certClient, 'lookup').mockResolvedValue({
      host: 'pmh.codes',
      port: 443,
      subject: { CN: 'pmh.codes' },
      issuer: { CN: 'Example CA' },
      validFrom: 'Jan  1 00:00:00 2026 GMT',
      validTo: 'Jan  1 00:00:00 2027 GMT',
      serialNumber: '02',
      authorized: false,
      authorizationError: 'self-signed certificate'
    })

    const calls = await dispatch(commandJSON('cert pmh.codes --pub'), subs)
    const defer = getCallback(calls) as { type: number; data: { flags: number } }

    expect(defer.type).toBe(InteractionResponseType.DeferredChannelMessageWithSource)
    expect(defer.data.flags & MessageFlags.Ephemeral).toBeFalsy()
  })
})

describe('cert — autocomplete', () => {
  it('returns cert in selection mode', async () => {
    const calls = await dispatch(autocompleteJSON('ce'), subs)
    const body = getCallback(calls) as { type: number; data: { choices: { value: string }[] } }

    expect(body.type).toBe(InteractionResponseType.ApplicationCommandAutocompleteResult)
    expect(body.data.choices.some((choice) => choice.value === 'cert')).toBe(true)
  })
})
