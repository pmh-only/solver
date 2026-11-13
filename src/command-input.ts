import { Collection, MessageFlags } from 'discord.js'
import type { CommandInteraction, InteractionRecovery, Subcommand } from './types.js'
import { buildAliasMap, markPubtabContext, parseFlags, resolveAliases } from './flags.js'
import { evaluateMathString } from './commands/math_core.js'
import { getStoredValue, hasStoredValue, isInternalStoredKey } from './helpers/kv-store.js'
import {
  container,
  contentPublishButtonRow,
  errorContainer,
  sendCommandReply,
  sendPlainTextReply
} from './components.js'

export function resolveCommandInput(rawInput: string, subcommands: Collection<string, Subcommand>) {
  const raw = rawInput.trim()
  const { bare, flags: rawFlags } = parseFlags(raw)
  const subName = bare.split(/\s+/)[0].toLowerCase()
  const sub = subcommands.get(subName)
  const globalAliases = buildAliasMap({ pub: { alias: 'p' } })
  const cmdAliases = sub ? buildAliasMap(sub.flags ?? {}) : new Map<string, string>()
  const flags = resolveAliases(rawFlags, new Map([...globalAliases, ...cmdAliases]))
  return { raw, bare, flags, subName, sub }
}

export async function runCommandInput(
  interaction: CommandInteraction,
  subcommands: Collection<string, Subcommand>,
  rawInput: string,
  fromPubtab = false,
  recover?: InteractionRecovery
) {
  const { bare, flags, sub } = resolveCommandInput(rawInput, subcommands)
  if (fromPubtab) markPubtabContext(flags)
  if (!sub) {
    if (/[+\-*/%^()]/.test(bare)) {
      try {
        await sendCommandReply(interaction, container(bare, flags, evaluateMathString(bare)))
      } catch (error) {
        const message = error instanceof Error ? error.message : 'math err'
        await sendCommandReply(interaction, container(bare, flags, message))
      }
      return
    }
    if (!bare.includes(' ')) {
      const storedValue =
        !isInternalStoredKey(bare) && hasStoredValue(bare) ? getStoredValue(bare) : undefined
      const replyFlags = flags.has('pub') ? undefined : ([MessageFlags.Ephemeral] as const)
      await sendPlainTextReply(
        interaction,
        storedValue !== undefined
          ? flags.has('pub')
            ? { content: storedValue }
            : {
                content: storedValue,
                components: [contentPublishButtonRow(storedValue)],
                flags: replyFlags
              }
          : { content: `no ${bare}`, flags: replyFlags }
      )
      return
    }
    await sendCommandReply(interaction, container(bare, flags, 'no cmd'))
    return
  }
  try {
    await sub.execute(interaction, bare, flags)
  } catch (error) {
    console.error(error)
    if (recover) {
      try {
        await recover(interaction, error, `command ${bare.slice(0, 500) || 'unknown'}`)
        return
      } catch (recoveryError) {
        console.error('command recovery failed', recoveryError)
      }
    }
    const message = error instanceof Error ? error.message : String(error)
    await sendCommandReply(interaction, errorContainer(bare, flags, message))
  }
}
