import type { ChatInputCommandInteraction } from 'discord.js'
import { TextDisplayBuilder } from 'discord.js'
import { parseFlags, buildAliasMap, resolveAliases } from '../flags.js'
import type { Subcommand } from '../types.js'

export interface ReplyCall {
  method: 'reply' | 'deferReply' | 'editReply' | 'followUp'
  options: unknown
}

export interface MockInteraction {
  interaction: ChatInputCommandInteraction
  calls: ReplyCall[]
}

export function mockInteraction(createdTimestamp = Date.now()): MockInteraction {
  const calls: ReplyCall[] = []
  let replied = false
  let deferred = false

  const interaction = {
    createdTimestamp,
    get replied() { return replied },
    get deferred() { return deferred },
    async reply(options: unknown) {
      replied = true
      calls.push({ method: 'reply', options })
    },
    async deferReply(options?: unknown) {
      deferred = true
      calls.push({ method: 'deferReply', options })
    },
    async editReply(options: unknown) {
      calls.push({ method: 'editReply', options })
    },
    async followUp(options: unknown) {
      calls.push({ method: 'followUp', options })
    },
  } as unknown as ChatInputCommandInteraction

  return { interaction, calls }
}

/**
 * Run a subcommand with a raw input string (same format the user types).
 * Returns the mock interaction and captured calls.
 */
export async function runCommand(sub: Subcommand, input: string): Promise<MockInteraction> {
  const { bare, flags: rawFlags } = parseFlags(input)
  const globalAliases = buildAliasMap({ pub: { alias: 'p' } })
  const cmdAliases = buildAliasMap(sub.flags ?? {})
  const flags = resolveAliases(rawFlags, new Map([...globalAliases, ...cmdAliases]))

  const mock = mockInteraction()
  await sub.execute(mock.interaction, bare, flags)
  return mock
}

/**
 * Extract all plain text from Components V2 components in a reply call.
 * Concatenates content from every TextDisplayBuilder in order.
 */
export function extractText(call: ReplyCall): string {
  const options = call.options as { components?: unknown[] } | null
  if (!options?.components) return ''
  return options.components
    .filter((c): c is TextDisplayBuilder => c instanceof TextDisplayBuilder)
    .map((c) => c.data.content ?? '')
    .join('\n')
}

/**
 * Get the last reply-like call (editReply if deferred, else reply).
 */
export function getReply(calls: ReplyCall[]): ReplyCall | undefined {
  return [...calls].reverse().find((c) => c.method === 'reply' || c.method === 'editReply')
}
