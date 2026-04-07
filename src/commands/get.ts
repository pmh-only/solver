import type { Subcommand } from '../types.js'
import {
  commandContainer,
  commandReferenceReply,
  sendCommandReply,
  separator,
  summarySection,
  text
} from '../components.js'
import { getStoredValue, hasStoredValue } from '../helpers/kv-store.js'

function parseGetArgs(args: string): string {
  return args.replace(/^\S+\s*/, '').trim()
}

export const subcommand: Subcommand = {
  name: 'get',
  description: 'get var',
  usage: 'get <key> [--pub]',
  examples: ['get token', 'get answer'],

  async execute(interaction, args, flags) {
    const key = parseGetArgs(args)

    if (!key) {
      await sendCommandReply(
        interaction,
        commandReferenceReply(subcommand, args, flags, 'usage', 'no key')
      )
      return
    }

    if (!hasStoredValue(key)) {
      await sendCommandReply(
        interaction,
        commandContainer(
          subcommand,
          args,
          flags,
          summarySection('Stored value', ['Key was not found']),
          separator(),
          text(`**Lookup**\n\`no ${key}\``)
        )
      )
      return
    }

    const value = getStoredValue(key) as string
    await sendCommandReply(
      interaction,
      commandContainer(
        subcommand,
        args,
        flags,
        summarySection('Stored value', [`Key \`${key}\` resolved successfully`]),
        separator(),
        text(`**Value**\n\`${key}=${value}\``)
      )
    )
  }
}
