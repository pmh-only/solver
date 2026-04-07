import type { ChatInputCommandInteraction } from 'discord.js'
import type { Flags } from './flags.js'

export interface FlagDef {
  description: string
  alias?: string   // single char, e.g. 'p' for --pub via -p or combined -abp
  value?: 'string' // present = takes a value, absent = boolean
}

export interface Subcommand {
  name: string
  description: string
  flags?: Record<string, FlagDef>
  autocomplete?: (restArgs: string, flags: Flags) => Promise<{ name: string; value: string }[]>
  execute: (interaction: ChatInputCommandInteraction, args: string, flags: Flags) => Promise<void>
}
