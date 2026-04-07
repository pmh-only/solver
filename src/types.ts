import type {
  ButtonInteraction,
  ChatInputCommandInteraction,
  ModalSubmitInteraction,
  StringSelectMenuInteraction
} from 'discord.js'
import type { TopLevelComponent } from './components.js'
import type { Flags } from './flags.js'

export interface FlagDef {
  description: string
  alias?: string // single char, e.g. 'p' for --pub via -p or combined -abp
  value?: 'string' // present = takes a value, absent = boolean
}

export type CommandInteraction =
  | ChatInputCommandInteraction
  | ButtonInteraction
  | StringSelectMenuInteraction
  | ModalSubmitInteraction

export type CommandRunResult = TopLevelComponent | TopLevelComponent[]

export interface Subcommand {
  name: string
  description: string
  usage?: string
  examples?: string[]
  flags?: Record<string, FlagDef>
  autocomplete?: (restArgs: string, flags: Flags) => Promise<{ name: string; value: string }[]>
  execute: (interaction: CommandInteraction, args: string, flags: Flags) => Promise<void>
  run?: (args: string, flags: Flags) => Promise<CommandRunResult>
}
