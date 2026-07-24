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

export const CONFIG_ENV_KEYS = [
  'DISCORD_TOKEN',
  'DISCORD_CLIENT_ID',
  'ADMIN_USER_IDS',
  'PORT',
  'WEB_HOST',
  'IMAP_HOST',
  'IMAP_PORT',
  'IMAP_SECURE',
  'IMAP_USER',
  'IMAP_PASS',
  'IMAP_MAILBOX',
  'KV_STORE_PATH',
  'OPENAI_API_KEY',
  'OPENAI_ADMIN_KEY',
  'FIRECRAWL_API_KEY'
] as const

const configEnvKeys = new Set<string>(CONFIG_ENV_KEYS)

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

    const isConfigEnv = configEnvKeys.has(parsed.key)
    if (isConfigEnv) process.env[parsed.key] = parsed.value
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
