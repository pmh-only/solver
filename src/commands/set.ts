import type { Subcommand } from '../types.js'
import {
  commandContainer,
  commandReferenceReply,
  sendCommandReply,
  separator,
  summarySection,
  text
} from '../components.js'
import { isInternalStoredKey, setStoredValue } from '../helpers/kv-store.js'

function parseSetArgs(args: string): { key: string; value: string } | null {
  const restArgs = args.replace(/^\S+\s*/, '').trim()
  const firstSpace = restArgs.indexOf(' ')

  if (firstSpace <= 0) return null

  const key = restArgs.slice(0, firstSpace).trim()
  const value = restArgs.slice(firstSpace + 1).trim()

  if (!key || !value) return null

  return { key, value }
}

export const subcommand: Subcommand = {
  name: 'set',
  description: 'set var',
  usage: 'set <key> <value> [--pub]',
  examples: ['set token abc123', 'set answer 42'],

  async execute(interaction, args, flags) {
    const parsed = parseSetArgs(args)

    if (!parsed) {
      await sendCommandReply(
        interaction,
        commandReferenceReply(subcommand, args, flags, 'usage', 'no args')
      )
      return
    }

    if (isInternalStoredKey(parsed.key)) {
      await sendCommandReply(
        interaction,
        commandReferenceReply(subcommand, args, flags, 'usage', 'reserved key')
      )
      return
    }

    setStoredValue(parsed.key, parsed.value)
    await sendCommandReply(
      interaction,
      commandContainer(
        subcommand,
        args,
        flags,
        summarySection('Stored value updated', [`Key \`${parsed.key}\` saved successfully`]),
        separator(),
        text(`**Result**\n\`ok ${parsed.key}=${parsed.value}\``)
      )
    )
  }
}
