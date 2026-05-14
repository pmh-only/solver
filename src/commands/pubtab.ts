import { ActionRowBuilder, ButtonBuilder, ButtonStyle } from 'discord.js'
import type { Subcommand } from '../types.js'
import { constrainedCommandButton, sendPlainTextReply } from '../components.js'

const SAFE_COMMANDS = [
  { label: 'Ping', command: 'ping', args: '1.1.1.1' },
  { label: 'DNS', command: 'dig', args: 'example.com' },
  { label: 'Whois', command: 'whois', args: 'example.com' },
  { label: 'TLS', command: 'cert', args: 'example.com' },
  { label: 'GeoIP', command: 'geoip', args: '1.1.1.1' },
  { label: 'Math', command: 'math', args: '2*(3+4)' },
  { label: 'Convert', command: 'conv', args: '255 to hex' },
  { label: 'RPS', command: 'rps', args: 'duel' }
]

function buildRows() {
  const rows: ActionRowBuilder<ButtonBuilder>[] = []

  for (let index = 0; index < SAFE_COMMANDS.length; index += 5) {
    rows.push(
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        SAFE_COMMANDS.slice(index, index + 5).map(({ label, command, args }) =>
          constrainedCommandButton(label, { command, args }, ButtonStyle.Secondary)
        )
      )
    )
  }

  return rows
}

export const subcommand: Subcommand = {
  name: 'pubtab',
  description: 'public safe command tab',
  usage: 'pubtab',
  examples: ['pubtab'],

  async execute(interaction) {
    await sendPlainTextReply(interaction, {
      content: 'Safe commands for anyone to run:',
      components: buildRows()
    })
  }
}
