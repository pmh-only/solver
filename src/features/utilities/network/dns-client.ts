import { randomBytes } from 'node:crypto'
import { createSocket, type SocketType } from 'node:dgram'

const DNS_PORT = 53
const DNS_TIMEOUT = 5000
const DEFAULT_SERVER = '1.1.1.1'

const TYPE_BY_NAME = {
  A: 1,
  NS: 2,
  CNAME: 5,
  SOA: 6,
  MX: 15,
  TXT: 16,
  AAAA: 28,
  SRV: 33,
  HTTPS: 65
} as const

const NAME_BY_TYPE = Object.fromEntries(
  Object.entries(TYPE_BY_NAME).map(([name, value]) => [value, name])
) as Record<number, keyof typeof TYPE_BY_NAME>

export interface DnsAnswer {
  name: string
  type: string
  ttl: number
  data: string
}

export interface DigResult {
  name: string
  type: string
  server: string
  answers: DnsAnswer[]
  authority: DnsAnswer[]
  additional: DnsAnswer[]
}

function encodeName(name: string): Buffer {
  const labels = name.replace(/\.+$/, '').split('.')
  const parts = labels.map((label) => {
    const data = Buffer.from(label, 'ascii')
    return Buffer.concat([Buffer.from([data.length]), data])
  })
  return Buffer.concat([...parts, Buffer.from([0])]) as Buffer
}

function decodeName(message: Buffer, offset: number): { name: string; nextOffset: number } {
  const labels: string[] = []
  let cursor = offset
  let nextOffset = offset
  let jumped = false
  let steps = 0

  while (steps < 256) {
    steps += 1
    const len = message[cursor]

    if ((len & 0xc0) === 0xc0) {
      const pointer = ((len & 0x3f) << 8) | message[cursor + 1]
      if (!jumped) nextOffset = cursor + 2
      cursor = pointer
      jumped = true
      continue
    }

    if (len === 0) {
      if (!jumped) nextOffset = cursor + 1
      break
    }

    const start = cursor + 1
    const end = start + len
    labels.push(message.subarray(start, end).toString('utf8'))
    cursor = end
    if (!jumped) nextOffset = cursor
  }

  return { name: labels.join('.'), nextOffset }
}

function formatIpv6(data: Buffer): string {
  const groups: string[] = []
  for (let i = 0; i < data.length; i += 2) groups.push(data.readUInt16BE(i).toString(16))
  return groups.join(':').replace(/(^|:)0(:0)+(:|$)/, '::')
}

function parseTxt(data: Buffer): string {
  const parts: string[] = []
  for (let offset = 0; offset < data.length;) {
    const len = data[offset]
    offset += 1
    parts.push(data.subarray(offset, offset + len).toString('utf8'))
    offset += len
  }
  return parts.join(' ')
}

function svcParamName(key: number): string {
  switch (key) {
    case 1:
      return 'alpn'
    case 2:
      return 'no-default-alpn'
    case 3:
      return 'port'
    case 4:
      return 'ipv4hint'
    case 5:
      return 'ech'
    case 6:
      return 'ipv6hint'
    default:
      return `key${key}`
  }
}

function parseSvcParamValue(key: number, value: Buffer): string {
  if (key === 1) {
    const items: string[] = []
    for (let offset = 0; offset < value.length;) {
      const len = value[offset]
      offset += 1
      items.push(value.subarray(offset, offset + len).toString('utf8'))
      offset += len
    }
    return items.join(',')
  }
  if (key === 2) return 'true'
  if (key === 3 && value.length === 2) return String(value.readUInt16BE(0))
  if (key === 4) {
    const items: string[] = []
    for (let offset = 0; offset + 4 <= value.length; offset += 4) {
      items.push(Array.from(value.subarray(offset, offset + 4)).join('.'))
    }
    return items.join(',')
  }
  if (key === 6) {
    const items: string[] = []
    for (let offset = 0; offset + 16 <= value.length; offset += 16) {
      items.push(formatIpv6(value.subarray(offset, offset + 16)))
    }
    return items.join(',')
  }
  return value.toString('base64')
}

function parseSvcb(message: Buffer, offset: number, length: number): string {
  const priority = message.readUInt16BE(offset)
  const target = decodeName(message, offset + 2)
  const params: string[] = []
  let cursor = target.nextOffset
  const end = offset + length

  while (cursor + 4 <= end) {
    const key = message.readUInt16BE(cursor)
    const valueLength = message.readUInt16BE(cursor + 2)
    const value = message.subarray(cursor + 4, cursor + 4 + valueLength)
    params.push(`${svcParamName(key)}=${parseSvcParamValue(key, value)}`)
    cursor += 4 + valueLength
  }

  return [String(priority), target.name || '.', ...params].join(' ')
}

function parseRdata(type: number, message: Buffer, offset: number, length: number): string {
  const data = message.subarray(offset, offset + length)

  switch (type) {
    case TYPE_BY_NAME.A:
      return Array.from(data).join('.')
    case TYPE_BY_NAME.AAAA:
      return formatIpv6(data)
    case TYPE_BY_NAME.NS:
    case TYPE_BY_NAME.CNAME:
      return decodeName(message, offset).name
    case TYPE_BY_NAME.MX: {
      const preference = message.readUInt16BE(offset)
      const exchange = decodeName(message, offset + 2).name
      return `${preference} ${exchange}`
    }
    case TYPE_BY_NAME.SOA: {
      const mname = decodeName(message, offset)
      const rname = decodeName(message, mname.nextOffset)
      const serial = message.readUInt32BE(rname.nextOffset)
      const refresh = message.readUInt32BE(rname.nextOffset + 4)
      const retry = message.readUInt32BE(rname.nextOffset + 8)
      const expire = message.readUInt32BE(rname.nextOffset + 12)
      const minimum = message.readUInt32BE(rname.nextOffset + 16)
      return `${mname.name} ${rname.name} serial=${serial} refresh=${refresh} retry=${retry} expire=${expire} minimum=${minimum}`
    }
    case TYPE_BY_NAME.TXT:
      return parseTxt(data)
    case TYPE_BY_NAME.HTTPS:
      return parseSvcb(message, offset, length)
    default:
      return `0x${data.toString('hex')}`
  }
}

function parseRecords(
  message: Buffer,
  offset: number,
  count: number
): { records: DnsAnswer[]; nextOffset: number } {
  const records: DnsAnswer[] = []
  let cursor = offset

  for (let i = 0; i < count; i += 1) {
    const name = decodeName(message, cursor)
    const type = message.readUInt16BE(name.nextOffset)
    const ttl = message.readUInt32BE(name.nextOffset + 4)
    const rdlength = message.readUInt16BE(name.nextOffset + 8)
    const rdataOffset = name.nextOffset + 10

    records.push({
      name: name.name,
      type: NAME_BY_TYPE[type] ?? `TYPE${type}`,
      ttl,
      data: parseRdata(type, message, rdataOffset, rdlength)
    })

    cursor = rdataOffset + rdlength
  }

  return { records, nextOffset: cursor }
}

function buildQuery(name: string, type: number, id: number): Buffer {
  const header = Buffer.alloc(12)
  header.writeUInt16BE(id, 0)
  header.writeUInt16BE(0x0100, 2)
  header.writeUInt16BE(1, 4)

  const qname = encodeName(name)
  const question = Buffer.alloc(4)
  question.writeUInt16BE(type, 0)
  question.writeUInt16BE(1, 2)

  return Buffer.concat([header, qname, question]) as Buffer
}

async function sendDnsQuery(server: string, packet: Buffer): Promise<Buffer> {
  const family: SocketType = server.includes(':') ? 'udp6' : 'udp4'

  return await new Promise((resolve, reject) => {
    const socket = createSocket(family)
    const timer = setTimeout(() => {
      socket.close()
      reject(new Error('dns timeout'))
    }, DNS_TIMEOUT)

    socket.once('message', (message) => {
      clearTimeout(timer)
      socket.close()
      resolve(message)
    })
    socket.once('error', (error) => {
      clearTimeout(timer)
      socket.close()
      reject(error)
    })
    socket.send(packet, DNS_PORT, server, (error) => {
      if (error) {
        clearTimeout(timer)
        socket.close()
        reject(error)
      }
    })
  })
}

function normalizeType(input: string | undefined): keyof typeof TYPE_BY_NAME {
  const type = (input ?? 'A').trim().toUpperCase()
  if (type in TYPE_BY_NAME) return type as keyof typeof TYPE_BY_NAME
  throw new Error('bad type')
}

function normalizeName(input: string): string {
  const name = input.trim().replace(/\.+$/, '')
  if (!name) throw new Error('no host')
  return name
}

async function lookup(
  nameInput: string,
  typeInput?: string,
  server = DEFAULT_SERVER
): Promise<DigResult> {
  const name = normalizeName(nameInput)
  const type = normalizeType(typeInput)
  const id = randomBytes(2).readUInt16BE(0)
  const packet = buildQuery(name, TYPE_BY_NAME[type], id)
  const response = await sendDnsQuery(server, packet)

  if (response.readUInt16BE(0) !== id) throw new Error('dns id mismatch')

  const flags = response.readUInt16BE(2)
  const rcode = flags & 0x000f
  if (rcode !== 0) throw new Error(`dns err ${rcode}`)

  const qdcount = response.readUInt16BE(4)
  const ancount = response.readUInt16BE(6)
  const nscount = response.readUInt16BE(8)
  const arcount = response.readUInt16BE(10)

  let offset = 12
  for (let i = 0; i < qdcount; i += 1) {
    const question = decodeName(response, offset)
    offset = question.nextOffset + 4
  }

  const answers = parseRecords(response, offset, ancount)
  const authority = parseRecords(response, answers.nextOffset, nscount)
  const additional = parseRecords(response, authority.nextOffset, arcount)

  return {
    name,
    type,
    server,
    answers: answers.records,
    authority: authority.records,
    additional: additional.records
  }
}

export const dnsClient = {
  lookup
}
