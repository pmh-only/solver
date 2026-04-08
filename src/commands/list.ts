import type { Subcommand } from '../types.js'
import {
  commandContainer,
  sendCommandReply,
  separator,
  summarySection,
  text
} from '../components.js'
import { listStoredKeys } from '../helpers/kv-store.js'

export const subcommand: Subcommand = {
  name: 'list',
  description: 'list vars',
  usage: 'list [--pub]',
  examples: ['list'],

  async execute(interaction, args, flags) {
    const internalPrefixes = ['command-input:', 'message-input:', 'message-render-', 'message-store-', 'pub-content:']
    const keys = listStoredKeys().filter((k) => !internalPrefixes.some((p) => k.startsWith(p)))

    if (keys.length === 0) {
      await sendCommandReply(
        interaction,
        commandContainer(
          subcommand,
          args,
          flags,
          summarySection('Stored values', ['No keys found']),
          separator(),
          text('**Keys**\n`(empty)`')
        )
      )
      return
    }

    const header = '**Keys**\n'
    const maxLen = 3600
    const lines: string[] = []
    let len = 0

    for (const k of keys) {
      const line = `\`${k}\``
      const added = line.length + (lines.length > 0 ? 1 : 0)
      if (len + added > maxLen) {
        lines.push(`*… and ${keys.length - lines.length} more*`)
        break
      }
      lines.push(line)
      len += added
    }

    await sendCommandReply(
      interaction,
      commandContainer(
        subcommand,
        args,
        flags,
        summarySection('Stored values', [`${keys.length} key${keys.length === 1 ? '' : 's'} found`]),
        separator(),
        text(`${header}${lines.join('\n')}`)
      )
    )
  }
}
