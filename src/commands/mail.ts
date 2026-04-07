import {
  ActionRowBuilder,
  StringSelectMenuBuilder,
  StringSelectMenuOptionBuilder
} from 'discord.js'
import type { StringSelectMenuInteraction } from 'discord.js'
import type { Subcommand } from '../types.js'
import type { Flags } from '../flags.js'
import type { TopLevelComponent } from '../components.js'
import {
  commandContainer,
  commandReferenceReply,
  container,
  deferCommandResponse,
  sendCommandReply,
  separator,
  summarySection,
  text
} from '../components.js'
import {
  createMailSession,
  getMailMessage,
  getMailSession,
  listRecentMail,
  resolveMailbox
} from '../helpers/mail.js'

export const MAIL_MESSAGE_SELECT_ID = 'mail-message'

function parseLimit(raw: string | boolean | undefined): number {
  const fallback = 10
  if (typeof raw !== 'string' || !raw.trim()) return fallback

  const value = Number(raw)
  if (!Number.isInteger(value) || value <= 0) return fallback
  return Math.min(value, 25)
}

function parseMailbox(args: string, flags: Flags): string {
  const restArgs = args.replace(/^\S+\s*/, '').trim()
  const mailboxFlag = flags.get('mailbox')
  return resolveMailbox(typeof mailboxFlag === 'string' ? mailboxFlag : restArgs)
}

function truncate(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max - 3)}...` : value
}

function compactMailList(
  messages: Awaited<ReturnType<typeof listRecentMail>>,
  maxItems: number,
  lineWidth: number
) {
  return messages
    .slice(0, maxItems)
    .map(
      (message, index) =>
        `${index + 1}. **${truncate(message.subject, lineWidth)}**\n${truncate(message.from, lineWidth)}\n${message.date} | ${message.seen ? 'read' : 'unread'}`
    )
}

function buildMailSelectRow(
  sessionId: string,
  messages: Awaited<ReturnType<typeof listRecentMail>>
) {
  if (messages.length === 0) return null

  const select = new StringSelectMenuBuilder()
    .setCustomId(MAIL_MESSAGE_SELECT_ID)
    .setPlaceholder('Select a message')
    .addOptions(
      messages.slice(0, 25).map((message, index) => {
        const subject = truncate(message.subject, 100)
        const description = truncate(
          `${message.from} | ${message.date} | ${message.seen ? 'read' : 'unread'}`,
          100
        )

        return new StringSelectMenuOptionBuilder()
          .setLabel(truncate(`${index + 1}. ${subject}`, 100))
          .setValue(`${sessionId}:${message.uid}`)
          .setDescription(description)
      })
    )

  return new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(select)
}

function buildMailReply(
  args: string,
  flags: Flags,
  mailbox: string,
  messages: Awaited<ReturnType<typeof listRecentMail>>,
  selected?: Awaited<ReturnType<typeof getMailMessage>>
) {
  const summary = selected
    ? [
        `Showing ${messages.length} recent messages from \`${mailbox}\``,
        `Opened: ${selected.subject}`
      ]
    : [`Fetched ${messages.length} recent messages from \`${mailbox}\``, 'Choose a message below']

  const list = compactMailList(messages, selected ? 5 : 10, selected ? 56 : 80)

  const body: TopLevelComponent[] = [
    summarySection(selected ? 'Mail message' : 'Recent mail', summary)
  ]

  if (!selected) {
    body.push(separator(), text(`**Messages**\n${list.join('\n\n') || '-# no mail'}`))
  }

  if (selected) {
    body.push(
      separator(),
      text(
        [
          '**Selected message**',
          `- **Subject:** ${truncate(selected.subject, 120)}`,
          `- **From:** ${truncate(selected.from, 120)}`,
          `- **To:** ${truncate(selected.to, 120)}`,
          `- **Date:** ${selected.date}`
        ].join('\n')
      ),
      text(`**Body**\n\n${truncate(selected.text || '(no text body)', 2800)}`)
    )
  }

  const payload = commandContainer(subcommand, args, flags, ...body)
  const sessionId = createMailSession({
    args,
    flags: [...flags.entries()],
    mailbox,
    messages
  })
  const selectRow = buildMailSelectRow(sessionId, messages)

  return selectRow
    ? {
        ...payload,
        components: [payload.components[0], selectRow, ...payload.components.slice(1)]
      }
    : payload
}

export async function handleMailSelect(interaction: StringSelectMenuInteraction) {
  const selected = interaction.values[0]
  if (!selected) {
    await sendCommandReply(interaction, container('mail', new Map(), 'no mail selected'))
    return
  }

  const separatorIndex = selected.indexOf(':')
  if (separatorIndex <= 0) {
    await sendCommandReply(interaction, container('mail', new Map(), 'invalid mail selection'))
    return
  }

  const sessionId = selected.slice(0, separatorIndex)
  const uid = Number(selected.slice(separatorIndex + 1))
  const session = getMailSession(sessionId)

  if (!session || !Number.isInteger(uid)) {
    await sendCommandReply(
      interaction,
      container('mail', new Map(), 'mail list expired; rerun `mail`')
    )
    return
  }

  const flags = new Map(session.flags)

  await deferCommandResponse(interaction, flags)

  try {
    const message = await getMailMessage(session.mailbox, uid)
    await sendCommandReply(
      interaction,
      buildMailReply(session.args, flags, session.mailbox, session.messages, message)
    )
  } catch (error) {
    const detail = error instanceof Error ? error.message : 'mail read failed'
    await sendCommandReply(
      interaction,
      commandReferenceReply(subcommand, session.args, flags, 'usage', detail)
    )
  }
}

export const subcommand: Subcommand = {
  name: 'mail',
  description: 'list recent imap mail',
  usage: 'mail [mailbox] [--limit <count>] [--mailbox <name>] [--pub]',
  examples: ['mail', 'mail --limit 5', 'mail Sent'],
  flags: {
    limit: { description: 'number of recent messages to fetch', value: 'string' },
    mailbox: { description: 'imap mailbox name override', value: 'string' }
  },

  async execute(interaction, args, flags) {
    const mailbox = parseMailbox(args, flags)
    const limit = parseLimit(flags.get('limit'))

    await deferCommandResponse(interaction, flags)

    try {
      const messages = await listRecentMail(mailbox, limit)
      if (messages.length === 0) {
        await sendCommandReply(
          interaction,
          commandReferenceReply(subcommand, args, flags, 'usage', `no mail in ${mailbox}`)
        )
        return
      }

      await sendCommandReply(interaction, buildMailReply(args, flags, mailbox, messages))
    } catch (error) {
      const detail = error instanceof Error ? error.message : 'mail fetch failed'
      await sendCommandReply(
        interaction,
        commandReferenceReply(subcommand, args, flags, 'usage', detail)
      )
    }
  }
}
