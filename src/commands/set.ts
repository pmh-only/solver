import type { Subcommand } from '../types.js'
import {
  commandContainer,
  commandReferenceReply,
  container,
  sendCommandReply,
  separator,
  summarySection,
  text
} from '../components.js'
import { isInternalStoredKey, setStoredValue } from '../helpers/kv-store.js'

const ENV_KEY_PREFIX = 'env:'

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
  usage: 'set <key|env:key> <value> [--pub]',
  examples: ['set token abc123', 'set answer 42', 'set env:OPENAI_API_KEY sk-...'],

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

    const isConfigEnv = parsed.key.startsWith(ENV_KEY_PREFIX)
    const envKey = parsed.key.slice(ENV_KEY_PREFIX.length)

    if (isConfigEnv && !envKey) {
      await sendCommandReply(
        interaction,
        commandReferenceReply(subcommand, args, flags, 'usage', 'environment key is required')
      )
      return
    }

    if (isConfigEnv) process.env[envKey] = parsed.value
    else setStoredValue(parsed.key, parsed.value)

    const components = [
      summarySection(isConfigEnv ? 'Environment updated' : 'Stored value updated', [
        `Key \`${parsed.key}\` updated successfully`
      ]),
      separator(),
      text(`**Result**\n\`ok ${parsed.key}=${isConfigEnv ? '[redacted]' : parsed.value}\``)
    ]
    const reply = isConfigEnv
      ? container(`set ${parsed.key} [redacted]`, flags, ...components)
      : commandContainer(subcommand, args, flags, ...components)

    await sendCommandReply(interaction, reply)
  }
}
