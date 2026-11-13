import { Socket } from 'node:net'

const WHOIS_TIMEOUT = 5000
const IANA_WHOIS_SERVER = 'whois.iana.org'
const RDAP_LOOKUP_URL = 'https://rdap.org/domain/'

interface RdapLookupResult {
  server: string
  fields: string[]
  raw: string
}

export interface WhoisResult {
  query: string
  server: string
  referral?: string
  fields: string[]
  raw: string
}

function normalizeWhoisText(text: string): string {
  return text.replace(/\r/g, '').trim()
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  return value as Record<string, unknown>
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value.filter((entry): entry is string => typeof entry === 'string' && entry.length > 0)
}

function uniqueLines(lines: Array<string | undefined>): string[] {
  return [
    ...new Set(
      lines.filter((line): line is string => Boolean(line?.trim())).map((line) => line.trim())
    )
  ]
}

function normalizeReferral(value: string): string | undefined {
  const match = value.trim().match(/^(?:\w+:\/\/)?([^/\s]+)$/)
  return match?.[1]?.toLowerCase() || undefined
}

export function extractReferral(text: string): string | undefined {
  for (const line of text.split('\n')) {
    const match = line.match(/^(?:refer|whois|referralserver|registrar whois server):\s*(.+)$/i)
    if (!match) continue

    const referral = normalizeReferral(match[1])
    if (referral) return referral
  }

  return undefined
}

export function selectInterestingLines(text: string): string[] {
  const patterns = [
    /^(domain name|domain|domain status|registrar|registrar whois server|registry domain id|creation date|created|updated date|updated|registry expiry date|expiry date|expiration date|expires|name server|nserver|status|dnssec):/i
  ]

  const lines = text
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => patterns.some((pattern) => pattern.test(line)))

  return [...new Set(lines)].slice(0, 16)
}

function extractVcardFullName(vcardArray: unknown): string | undefined {
  if (!Array.isArray(vcardArray) || !Array.isArray(vcardArray[1])) return undefined

  for (const field of vcardArray[1]) {
    if (!Array.isArray(field) || field[0] !== 'fn' || typeof field[3] !== 'string') continue
    const value = field[3].trim()
    if (value) return value
  }

  return undefined
}

function findRdapRegistrarName(entities: unknown): string | undefined {
  if (!Array.isArray(entities)) return undefined

  for (const entity of entities) {
    const record = asRecord(entity)
    if (!record) continue
    const roles = asStringArray(record.roles)
    if (!roles.includes('registrar')) continue

    const registrar = extractVcardFullName(record.vcardArray)
    if (registrar) return registrar
  }

  return undefined
}

function findRdapEventDate(events: unknown, action: string): string | undefined {
  if (!Array.isArray(events)) return undefined

  for (const event of events) {
    const record = asRecord(event)
    if (!record || record.eventAction !== action || typeof record.eventDate !== 'string') continue
    return record.eventDate
  }

  return undefined
}

export function selectInterestingRdapLines(document: string | Record<string, unknown>): string[] {
  const payload =
    typeof document === 'string' ? (JSON.parse(document) as Record<string, unknown>) : document
  const secureDns = asRecord(payload.secureDNS)
  const nameservers = Array.isArray(payload.nameservers)
    ? payload.nameservers
        .map((entry) => asRecord(entry))
        .map((entry) => entry?.ldhName)
        .filter((value): value is string => typeof value === 'string' && value.length > 0)
    : []

  return uniqueLines([
    typeof payload.ldhName === 'string'
      ? `Domain Name: ${payload.ldhName.toUpperCase()}`
      : undefined,
    typeof payload.handle === 'string' ? `Registry Domain ID: ${payload.handle}` : undefined,
    findRdapRegistrarName(payload.entities)
      ? `Registrar: ${findRdapRegistrarName(payload.entities)}`
      : undefined,
    findRdapEventDate(payload.events, 'registration')
      ? `Creation Date: ${findRdapEventDate(payload.events, 'registration')}`
      : undefined,
    findRdapEventDate(payload.events, 'last changed')
      ? `Updated Date: ${findRdapEventDate(payload.events, 'last changed')}`
      : undefined,
    findRdapEventDate(payload.events, 'expiration')
      ? `Registry Expiry Date: ${findRdapEventDate(payload.events, 'expiration')}`
      : undefined,
    ...nameservers.map((host) => `Name Server: ${host.toUpperCase()}`),
    ...asStringArray(payload.status).map((status) => `Status: ${status}`),
    typeof secureDns?.delegationSigned === 'boolean'
      ? `DNSSEC: ${secureDns.delegationSigned ? 'signed' : 'unsigned'}`
      : undefined
  ]).slice(0, 16)
}

function extractTld(domain: string): string {
  return domain.slice(domain.lastIndexOf('.') + 1)
}

async function queryWhoisServer(server: string, query: string): Promise<string> {
  return await new Promise((resolve, reject) => {
    const socket = new Socket()
    const chunks: Buffer[] = []

    const fail = (error: Error) => {
      socket.destroy()
      reject(error)
    }

    socket.setTimeout(WHOIS_TIMEOUT)
    socket.on('data', (chunk: Buffer) => chunks.push(chunk))
    socket.on('timeout', () => fail(new Error('whois timeout')))
    socket.on('error', (error) => fail(error))
    socket.on('close', (hadError) => {
      if (hadError) return
      resolve(normalizeWhoisText((Buffer.concat(chunks) as Buffer).toString('utf8')))
    })

    socket.connect(43, server, () => {
      socket.write(`${query}\r\n`)
      socket.end()
    })
  })
}

async function queryRdapDomain(domain: string): Promise<RdapLookupResult | null> {
  const response = await fetch(`${RDAP_LOOKUP_URL}${encodeURIComponent(domain)}`, {
    headers: { accept: 'application/rdap+json, application/json' },
    redirect: 'follow'
  })

  if (!response.ok) return null

  const raw = normalizeWhoisText(await response.text())
  if (!raw) return null

  const fields = selectInterestingRdapLines(raw)
  if (fields.length === 0) return null

  return {
    server: new URL(response.url).host,
    fields,
    raw
  }
}

function normalizeDomain(input: string): string {
  const value = input.trim().replace(/\.+$/, '').toLowerCase()
  if (!value || !/^[a-z0-9.-]+$/i.test(value) || !value.includes('.')) {
    throw new Error('bad dom')
  }
  return value
}

export async function lookupWhois(
  domain: string,
  queryServer: (server: string, query: string) => Promise<string> = queryWhoisServer,
  queryRdap: (domain: string) => Promise<RdapLookupResult | null> = queryRdapDomain
): Promise<WhoisResult> {
  const query = normalizeDomain(domain)
  const bootstrap = await queryServer(IANA_WHOIS_SERVER, extractTld(query))
  const referral = extractReferral(bootstrap)
  const bootstrapFields = selectInterestingLines(bootstrap)

  if (!referral || referral === IANA_WHOIS_SERVER) {
    const rdap = await queryRdap(query).catch(() => null)
    if (rdap) {
      return {
        query,
        server: rdap.server,
        referral,
        fields: rdap.fields,
        raw: rdap.raw
      }
    }

    return {
      query,
      server: IANA_WHOIS_SERVER,
      referral,
      fields: [
        'IANA WHOIS did not provide a registry referral, and RDAP lookup returned no data.',
        ...bootstrapFields
      ].slice(0, 16),
      raw: bootstrap
    }
  }

  const referred = await queryServer(referral, query)
  const referredFields = selectInterestingLines(referred)

  if (!referred) {
    const rdap = await queryRdap(query).catch(() => null)
    if (rdap) {
      return {
        query,
        server: rdap.server,
        referral,
        fields: rdap.fields,
        raw: rdap.raw
      }
    }

    return {
      query,
      server: referral,
      referral,
      fields: ['Registry WHOIS server returned no data, and RDAP lookup returned no data.'],
      raw: referred
    }
  }

  return {
    query,
    server: referral,
    referral,
    fields:
      referredFields.length > 0
        ? referredFields
        : ['Registry WHOIS response had no structured fields; showing raw output.'],
    raw: referred
  }
}

export const whoisClient = {
  lookup: lookupWhois
}
