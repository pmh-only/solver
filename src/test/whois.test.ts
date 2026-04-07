import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, it, expect, vi, afterEach } from 'vitest'
import { InteractionResponseType, MessageFlags } from 'discord.js'
import { subcommand as whois } from '../commands/whois.js'
import {
  extractReferral,
  lookupWhois,
  selectInterestingRdapLines,
  selectInterestingLines,
  whoisClient
} from '../commands/_whois.js'
import {
  autocompleteJSON,
  commandJSON,
  dispatch,
  getCallback,
  getEdit,
  makeSubcommands
} from './e2e.js'

const subs = makeSubcommands(whois)
const fixturesDir = fileURLToPath(new URL('./fixtures/whois/', import.meta.url))

async function loadFixture(name: string): Promise<string> {
  return await readFile(join(fixturesDir, name), 'utf8')
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('whois — command', () => {
  it('replies immediately with usage when no domain given', async () => {
    const calls = await dispatch(commandJSON('whois'), subs)
    const body = getCallback(calls) as { type: number; data: { flags: number } }

    expect(body.type).toBe(InteractionResponseType.ChannelMessageWithSource)
    expect(body.data.flags & MessageFlags.Ephemeral).toBeTruthy()
  })

  it('defers then edits when domain given', async () => {
    vi.spyOn(whoisClient, 'lookup').mockResolvedValue({
      query: 'google.com',
      server: 'whois.verisign-grs.com',
      fields: ['Registrar: MarkMonitor Inc.', 'Name Server: NS1.GOOGLE.COM'],
      raw: 'Registrar: MarkMonitor Inc.'
    })

    const calls = await dispatch(commandJSON('whois google.com'), subs)
    const defer = getCallback(calls) as { type: number; data: { flags: number } }
    const edit = getEdit(calls) as { components: unknown[] }

    expect(defer.type).toBe(InteractionResponseType.DeferredChannelMessageWithSource)
    expect(defer.data.flags & MessageFlags.Ephemeral).toBeTruthy()
    expect(edit.components).toBeDefined()
  })

  it('defers publicly with --pub', async () => {
    vi.spyOn(whoisClient, 'lookup').mockResolvedValue({
      query: 'pmh.codes',
      server: 'whois.nic.google',
      fields: ['Domain Name: PMH.CODES'],
      raw: 'Domain Name: PMH.CODES'
    })

    const calls = await dispatch(commandJSON('whois pmh.codes --pub'), subs)
    const defer = getCallback(calls) as { type: number; data: { flags: number } }

    expect(defer.type).toBe(InteractionResponseType.DeferredChannelMessageWithSource)
    expect(defer.data.flags & MessageFlags.Ephemeral).toBeFalsy()
  })
})

describe('whois — autocomplete', () => {
  it('returns whois in selection mode', async () => {
    const calls = await dispatch(autocompleteJSON('who'), subs)
    const body = getCallback(calls) as { type: number; data: { choices: { value: string }[] } }

    expect(body.type).toBe(InteractionResponseType.ApplicationCommandAutocompleteResult)
    expect(body.data.choices.some((choice) => choice.value === 'whois')).toBe(true)
  })
})

describe('whois — parsing', () => {
  it('extracts the registry referral from a real IANA response', async () => {
    const ianaCom = await loadFixture('iana-com.txt')

    expect(extractReferral(ianaCom)).toBe('whois.verisign-grs.com')
  })

  it('treats a blank IANA whois field as no referral', async () => {
    const ianaCodes = await loadFixture('iana-codes.txt')

    expect(extractReferral(ianaCodes)).toBeUndefined()
  })

  it('extracts structured fields from a real registry response', async () => {
    const registryGoogle = await loadFixture('registry-google.com.txt')
    const registryPmhCodes = await loadFixture('registry-pmh.codes.txt')

    expect(selectInterestingLines(registryGoogle)).toContain('Registrar: MarkMonitor Inc.')
    expect(selectInterestingLines(registryGoogle)).toContain('Name Server: NS1.GOOGLE.COM')
    expect(selectInterestingLines(registryGoogle)).toContain(
      'Domain Status: clientDeleteProhibited https://icann.org/epp#clientDeleteProhibited'
    )
    expect(selectInterestingLines(registryPmhCodes)).toContain('Registrar: NameCheap, Inc.')
    expect(selectInterestingLines(registryPmhCodes)).toContain('Name Server: NS1.PMH.CODES')
  })

  it('extracts structured fields from a real RDAP response', async () => {
    const rdapPmhCodes = await loadFixture('rdap-pmh.codes.json')

    expect(selectInterestingRdapLines(rdapPmhCodes)).toContain('Domain Name: PMH.CODES')
    expect(selectInterestingRdapLines(rdapPmhCodes)).toContain('Registrar: NameCheap, Inc.')
    expect(selectInterestingRdapLines(rdapPmhCodes)).toContain('Name Server: NS1.PMH.CODES')
  })
})

describe('whois — lookup internals', () => {
  it('bootstraps with the TLD and then queries the referred registry with the full domain', async () => {
    const ianaCom = await loadFixture('iana-com.txt')
    const registryGoogle = await loadFixture('registry-google.com.txt')
    const queryServer = vi.fn(async (server: string, query: string) => {
      if (server === 'whois.iana.org' && query === 'com') return ianaCom
      if (server === 'whois.verisign-grs.com' && query === 'google.com') return registryGoogle
      throw new Error(`unexpected lookup ${server} ${query}`)
    })

    const result = await lookupWhois('google.com', queryServer)

    expect(queryServer).toHaveBeenCalledTimes(2)
    expect(queryServer).toHaveBeenNthCalledWith(1, 'whois.iana.org', 'com')
    expect(queryServer).toHaveBeenNthCalledWith(2, 'whois.verisign-grs.com', 'google.com')
    expect(result.server).toBe('whois.verisign-grs.com')
    expect(result.referral).toBe('whois.verisign-grs.com')
    expect(result.fields).toContain('Registrar: MarkMonitor Inc.')
  })

  it('falls back to RDAP when IANA provides no registry referral', async () => {
    const ianaCodes = await loadFixture('iana-codes.txt')
    const rdapPmhCodes = await loadFixture('rdap-pmh.codes.json')
    const queryServer = vi.fn(async (server: string, query: string) => {
      if (server === 'whois.iana.org' && query === 'codes') return ianaCodes
      throw new Error(`unexpected lookup ${server} ${query}`)
    })
    const queryRdap = vi.fn(async (_domain: string) => ({
      server: 'rdap.identitydigital.services',
      fields: selectInterestingRdapLines(rdapPmhCodes),
      raw: rdapPmhCodes
    }))

    const result = await lookupWhois('pmh.codes', queryServer, queryRdap)

    expect(queryServer).toHaveBeenCalledTimes(1)
    expect(queryServer).toHaveBeenCalledWith('whois.iana.org', 'codes')
    expect(queryRdap).toHaveBeenCalledWith('pmh.codes')
    expect(result.server).toBe('rdap.identitydigital.services')
    expect(result.fields).toContain('Registrar: NameCheap, Inc.')
  })

  it('returns an explicit fallback when both WHOIS and RDAP provide no data', async () => {
    const ianaCodes = await loadFixture('iana-codes.txt')
    const queryServer = vi.fn(async (server: string, query: string) => {
      if (server === 'whois.iana.org' && query === 'codes') return ianaCodes
      throw new Error(`unexpected lookup ${server} ${query}`)
    })

    const result = await lookupWhois('pmh.codes', queryServer, async () => null)

    expect(queryServer).toHaveBeenCalledTimes(1)
    expect(queryServer).toHaveBeenCalledWith('whois.iana.org', 'codes')
    expect(result.server).toBe('whois.iana.org')
    expect(result.fields).toContain(
      'IANA WHOIS did not provide a registry referral, and RDAP lookup returned no data.'
    )
  })
})
