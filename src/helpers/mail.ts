import { randomUUID } from 'node:crypto'
import { ImapFlow, type MessageAddressObject } from 'imapflow'
import { simpleParser } from 'mailparser'
import TurndownService from 'turndown'
interface MailConfig {
  host: string
  port: number
  secure: boolean
  user: string
  pass: string
  mailbox: string
}

export interface MailListItem {
  uid: number
  subject: string
  from: string
  date: string
  seen: boolean
}

export interface MailMessage {
  subject: string
  from: string
  to: string
  date: string
  text: string
}

export interface MailSession {
  args: string
  flags: Array<[string, string | true]>
  mailbox: string
  messages: MailListItem[]
}

const MAIL_SESSION_TTL_MS = 15 * 60 * 1000
const turndown = new TurndownService({
  bulletListMarker: '-',
  codeBlockStyle: 'fenced',
  headingStyle: 'atx'
})

turndown.remove(['style', 'script', 'head', 'title', 'meta', 'link'])
turndown.addRule('removeImages', {
  filter: 'img',
  replacement: () => ''
})
turndown.addRule('removeEmptyLinks', {
  filter: (node) => node.nodeName === 'A' && !node.textContent?.trim(),
  replacement: () => ''
})

const mailSessions = new Map<string, { expiresAt: number; session: MailSession }>()

function cleanupSessions() {
  const now = Date.now()
  for (const [id, entry] of mailSessions.entries()) {
    if (entry.expiresAt <= now) {
      mailSessions.delete(id)
    }
  }
}

function requiredEnv(name: string): string {
  const value = process.env[name]?.trim()
  if (!value) throw new Error(`missing ${name}`)
  return value
}

function getMailConfig(): MailConfig {
  const port = Number(process.env.IMAP_PORT ?? '993')
  if (!Number.isInteger(port) || port <= 0) {
    throw new Error('invalid IMAP_PORT')
  }

  return {
    host: requiredEnv('IMAP_HOST'),
    port,
    secure: (process.env.IMAP_SECURE ?? 'true').toLowerCase() !== 'false',
    user: requiredEnv('IMAP_USER'),
    pass: requiredEnv('IMAP_PASS'),
    mailbox: process.env.IMAP_MAILBOX?.trim() || 'INBOX'
  }
}

async function withMailbox<T>(mailbox: string, run: (client: ImapFlow) => Promise<T>): Promise<T> {
  const config = getMailConfig()
  const client = new ImapFlow({
    host: config.host,
    port: config.port,
    secure: config.secure,
    logger: false,
    emitLogs: false,
    logRaw: false,
    auth: {
      user: config.user,
      pass: config.pass
    }
  })

  try {
    await client.connect()
    await client.mailboxOpen(mailbox, { readOnly: true })
    return await run(client)
  } finally {
    await client.logout().catch(() => undefined)
  }
}

function formatAddress(addresses?: MessageAddressObject[]): string {
  if (!addresses || addresses.length === 0) return 'unknown'

  const [first, ...rest] = addresses
  const primary =
    first?.name && first.address ? `${first.name} <${first.address}>` : first?.address || 'unknown'
  return rest.length > 0 ? `${primary} +${rest.length}` : primary
}

function formatDate(value?: Date): string {
  if (!value) return 'unknown'
  return value.toISOString().replace('T', ' ').slice(0, 16)
}

function cleanText(value: string): string {
  return value
    .replace(/\r/g, '')
    .replace(/\t/g, '  ')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

function htmlToMarkdown(value: string): string {
  return cleanText(
    turndown.turndown(
      value
        .replace(/<style[\s\S]*?<\/style>/gi, '')
        .replace(/<script[\s\S]*?<\/script>/gi, '')
        .replace(/<head[\s\S]*?<\/head>/gi, '')
    )
  )
}

function formatParsedAddress(value: unknown): string | null {
  if (!value || typeof value !== 'object' || !('text' in value)) return null
  return typeof value.text === 'string' && value.text.trim() ? value.text.trim() : null
}

export function resolveMailbox(value: string | undefined): string {
  return value?.trim() || getMailConfig().mailbox
}

export async function listRecentMail(mailbox: string, limit: number): Promise<MailListItem[]> {
  return withMailbox(mailbox, async (client) => {
    const uids = await client.search({ all: true }, { uid: true })
    if (!uids || uids.length === 0) return []

    const recent = uids.slice(-limit).reverse()
    const messages: MailListItem[] = []

    for await (const message of client.fetch(
      recent,
      { envelope: true, flags: true },
      { uid: true }
    )) {
      messages.push({
        uid: message.uid,
        subject: message.envelope?.subject?.trim() || '(no subject)',
        from: formatAddress(message.envelope?.from),
        date: formatDate(message.envelope?.date),
        seen: message.flags?.has('\\Seen') ?? false
      })
    }

    return messages.sort((a, b) => b.uid - a.uid)
  })
}

export async function getMailMessage(mailbox: string, uid: number): Promise<MailMessage> {
  return withMailbox(mailbox, async (client) => {
    const message = await client.fetchOne(
      String(uid),
      { envelope: true, source: true },
      { uid: true }
    )
    if (!message || !message.source) throw new Error('mail not found')

    const parsed = await simpleParser(message.source)
    const html = typeof parsed.html === 'string' ? parsed.html : parsed.html?.toString() || ''
    const text = html ? htmlToMarkdown(html) : cleanText(parsed.text || '(no text body)')

    return {
      subject: parsed.subject?.trim() || message.envelope?.subject?.trim() || '(no subject)',
      from: formatParsedAddress(parsed.from) || formatAddress(message.envelope?.from),
      to: formatParsedAddress(parsed.to) || formatAddress(message.envelope?.to),
      date: formatDate(parsed.date || message.envelope?.date),
      text
    }
  })
}

export function createMailSession(session: MailSession): string {
  cleanupSessions()
  const id = randomUUID()
  mailSessions.set(id, {
    expiresAt: Date.now() + MAIL_SESSION_TTL_MS,
    session
  })
  return id
}

export function getMailSession(id: string): MailSession | null {
  cleanupSessions()
  const entry = mailSessions.get(id)
  if (!entry) return null
  return entry.session
}
