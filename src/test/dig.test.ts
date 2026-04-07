import { describe, it, expect, vi, afterEach } from 'vitest'
import { InteractionResponseType, MessageFlags } from 'discord.js'
import { subcommand as dig } from '../commands/dig.js'
import { dnsClient } from '../commands/_dns.js'
import {
  autocompleteJSON,
  commandJSON,
  dispatch,
  getCallback,
  getEdit,
  makeSubcommands
} from './e2e.js'

const subs = makeSubcommands(dig)

afterEach(() => {
  vi.restoreAllMocks()
})

describe('dig — command', () => {
  it('replies immediately with usage when no hostname given', async () => {
    const calls = await dispatch(commandJSON('dig'), subs)
    const body = getCallback(calls) as { type: number; data: { flags: number } }

    expect(body.type).toBe(InteractionResponseType.ChannelMessageWithSource)
    expect(body.data.flags & MessageFlags.Ephemeral).toBeTruthy()
  })

  it('defers then edits for default lookup', async () => {
    vi.spyOn(dnsClient, 'lookup').mockResolvedValue({
      name: 'pmh.codes',
      type: 'A',
      server: '1.1.1.1',
      answers: [{ name: 'pmh.codes', type: 'A', ttl: 300, data: '203.0.113.10' }],
      authority: [],
      additional: []
    })

    const calls = await dispatch(commandJSON('dig pmh.codes'), subs)
    const defer = getCallback(calls) as { type: number; data: { flags: number } }
    const edit = getEdit(calls) as { components: unknown[] }

    expect(defer.type).toBe(InteractionResponseType.DeferredChannelMessageWithSource)
    expect(edit.components).toBeDefined()
  })

  it('passes through explicit record types like HTTPS', async () => {
    const spy = vi.spyOn(dnsClient, 'lookup').mockResolvedValue({
      name: 'pmh.codes',
      type: 'HTTPS',
      server: '1.1.1.1',
      answers: [
        { name: 'pmh.codes', type: 'HTTPS', ttl: 300, data: '1 . alpn=h3,h2 ipv4hint=203.0.113.10' }
      ],
      authority: [],
      additional: []
    })

    await dispatch(commandJSON('dig pmh.codes https'), subs)

    expect(spy).toHaveBeenCalledWith('pmh.codes', 'https')
  })

  it('defers publicly with --pub', async () => {
    vi.spyOn(dnsClient, 'lookup').mockResolvedValue({
      name: 'pmh.codes',
      type: 'SOA',
      server: '1.1.1.1',
      answers: [
        {
          name: 'pmh.codes',
          type: 'SOA',
          ttl: 300,
          data: 'ns1.example hostmaster.example serial=1 refresh=2 retry=3 expire=4 minimum=5'
        }
      ],
      authority: [],
      additional: []
    })

    const calls = await dispatch(commandJSON('dig pmh.codes soa --pub'), subs)
    const defer = getCallback(calls) as { type: number; data: { flags: number } }

    expect(defer.type).toBe(InteractionResponseType.DeferredChannelMessageWithSource)
    expect(defer.data.flags & MessageFlags.Ephemeral).toBeFalsy()
  })
})

describe('dig — autocomplete', () => {
  it('returns dig in selection mode', async () => {
    const calls = await dispatch(autocompleteJSON('di'), subs)
    const body = getCallback(calls) as { type: number; data: { choices: { value: string }[] } }

    expect(body.type).toBe(InteractionResponseType.ApplicationCommandAutocompleteResult)
    expect(body.data.choices.some((choice) => choice.value === 'dig')).toBe(true)
  })
})
