import { MessageFlags } from 'discord.js'
import type { Subcommand } from '../types.js'
import { contentPublishButtonRow, sendPlainTextReply } from '../components.js'
import { getStoredValue, hasStoredValue, isInternalStoredKey } from '../helpers/kv-store.js'

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
    const replyFlags = flags.has('pub') ? undefined : ([MessageFlags.Ephemeral] as const)

    if (!key) {
      await sendPlainTextReply(interaction, { content: 'no key', flags: replyFlags })
      return
    }

    if (isInternalStoredKey(key) || !hasStoredValue(key)) {
      await sendPlainTextReply(interaction, { content: `no ${key}`, flags: replyFlags })
      return
    }

    const value = getStoredValue(key) as string
    await sendPlainTextReply(
      interaction,
      flags.has('pub')
        ? { content: value }
        : {
            content: value,
            components: [contentPublishButtonRow(value)],
            flags: replyFlags
          }
    )
  }
}
