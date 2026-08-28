import {
  ApplicationCommandType,
  MessageFlags,
  type Interaction,
  type Collection,
  type MessageContextMenuCommandInteraction,
  type RepliableInteraction,
  type UserContextMenuCommandInteraction
} from 'discord.js'
import { z } from 'zod'
import { isAdminUser } from './authorization.js'
import {
  commandContainer,
  deferCommandResponse,
  errorContainer,
  scheduleEphemeralReplyDelete,
  sendCommandReply,
  text
} from './components.js'
import type { DiscordFeatureRegistry } from './feature-registry.js'
import type { Flags } from './flags.js'
import { safeErrorMessage } from './safe-error.js'
import {
  loadStoredDiscordFeatures,
  MAX_STORED_DISCORD_FEATURES,
  discordFeatureIdSchema,
  storedDiscordFeatureSchema,
  storeDiscordFeatures,
  type StoredDiscordFeature
} from './helpers/discord-feature-store.js'
import type { CommandInteraction, Subcommand } from './types.js'
import {
  executeDynamicJavascript,
  formatDynamicJavascriptResult,
  parseDynamicComponentsV2Response
} from './helpers/dynamic-javascript.js'

const DYNAMIC_FEATURE_REGISTRY_ID = 'dynamic-discord-features'
const DYNAMIC_FEATURE_PRIORITY = 0
const MAX_INVOCATION_JSON_LENGTH = 16_000

export interface DynamicFeatureInvocation {
  feature: StoredDiscordFeature
  interaction: RepliableInteraction
  input: string
  pub: boolean
}

interface DynamicDiscordFeatureRuntime {
  registry: DiscordFeatureRegistry
  subcommands: Collection<string, Subcommand>
  run: (invocation: DynamicFeatureInvocation) => Promise<void>
  syncCommands: (registry: DiscordFeatureRegistry) => Promise<void>
  cleanup?: (feature: StoredDiscordFeature) => void
  recover?: (interaction: Interaction, error: unknown, source: string) => Promise<void>
}

export type DynamicFeatureManagementInput =
  | { action: 'list' }
  | { action: 'remove'; id: string }
  | {
      action: 'upsert'
      id: string
      kind: 'command' | 'user' | 'message'
      name: string
      description: string
      instructions?: string
      code?: string
    }

function boundedJson(value: unknown): string {
  const json = JSON.stringify(value, (_, entry) =>
    typeof entry === 'bigint' ? entry.toString() : entry
  )
  return json.length <= MAX_INVOCATION_JSON_LENGTH
    ? json
    : `${json.slice(0, MAX_INVOCATION_JSON_LENGTH)}...[truncated]`
}

function commandInvocation(args: string, flags: Flags): string {
  return boundedJson({
    type: 'command',
    arguments: args.replace(/^\S+\s*/, '').trim(),
    flags: Object.fromEntries(flags)
  })
}

function userInvocation(interaction: UserContextMenuCommandInteraction): string {
  return boundedJson({
    type: 'user_context',
    target_user: interaction.targetUser.toJSON()
  })
}

function messageInvocation(interaction: MessageContextMenuCommandInteraction): string {
  return boundedJson({
    type: 'message_context',
    target_message: interaction.targetMessage.toJSON()
  })
}

function commandIdentity(feature: StoredDiscordFeature): string {
  return `${feature.kind}:${feature.name.toLowerCase()}`
}

function publicFeature(feature: StoredDiscordFeature): Record<string, string> {
  return {
    id: feature.id,
    kind: feature.kind,
    name: feature.name,
    description: feature.description,
    ...(feature.instructions
      ? {
          instructions:
            feature.instructions.length <= 1_000
              ? feature.instructions
              : `${feature.instructions.slice(0, 1_000)}...[truncated]`
        }
      : {}),
    ...(feature.code
      ? {
          code:
            feature.code.length <= 4_000
              ? feature.code
              : `${feature.code.slice(0, 4_000)}...[truncated]`
        }
      : {})
  }
}

export class DynamicDiscordFeatureManager {
  readonly #runtime: DynamicDiscordFeatureRuntime
  #dynamicCommandNames = new Set<string>()
  #features: StoredDiscordFeature[] = []

  constructor(runtime: DynamicDiscordFeatureRuntime) {
    this.#runtime = runtime
  }

  initialize(): void {
    try {
      this.#apply(loadStoredDiscordFeatures())
    } catch (error) {
      console.error('could not load dynamic Discord features', error)
      try {
        this.#apply([])
      } catch (fallbackError) {
        console.error('could not initialize empty dynamic Discord feature registry', fallbackError)
      }
    }
  }

  list(): StoredDiscordFeature[] {
    return structuredClone(this.#features)
  }

  async manage(input: DynamicFeatureManagementInput): Promise<string> {
    if (input.action === 'list') {
      return this.#features.length === 0
        ? 'No dynamic Discord features are configured.'
        : JSON.stringify(this.#features.map(publicFeature))
    }

    const parsedId = discordFeatureIdSchema.safeParse(input.id)
    if (!parsedId.success) return `Invalid Discord feature id: ${z.prettifyError(parsedId.error)}`

    const previous = this.list()
    let next: StoredDiscordFeature[]
    if (input.action === 'remove') {
      next = previous.filter(({ id }) => id !== parsedId.data)
      if (next.length === previous.length) return `Discord feature ${input.id} was not configured.`
    } else {
      const parsed = storedDiscordFeatureSchema.safeParse(input)
      if (!parsed.success) return `Invalid Discord feature: ${z.prettifyError(parsed.error)}`
      const feature = parsed.data
      const conflict = previous.find(
        (candidate) =>
          candidate.id !== feature.id && commandIdentity(candidate) === commandIdentity(feature)
      )
      if (conflict)
        return `Discord command ${feature.name} is already used by feature ${conflict.id}.`
      const index = previous.findIndex(({ id }) => id === feature.id)
      next = [...previous]
      if (index === -1) {
        if (next.length >= MAX_STORED_DISCORD_FEATURES) {
          return `At most ${MAX_STORED_DISCORD_FEATURES} dynamic Discord features may be configured.`
        }
        next.push(feature)
      } else {
        next[index] = feature
      }
    }

    let deploymentAttempted = false
    try {
      this.#apply(next)
      storeDiscordFeatures(next)
      deploymentAttempted = true
      await this.#runtime.syncCommands(this.#runtime.registry)
    } catch (error) {
      const rollbackFailures: string[] = []
      try {
        this.#apply(previous)
      } catch (rollbackError) {
        rollbackFailures.push(`runtime rollback: ${safeErrorMessage(rollbackError)}`)
      }
      try {
        storeDiscordFeatures(previous)
      } catch (rollbackError) {
        rollbackFailures.push(`storage rollback: ${safeErrorMessage(rollbackError)}`)
      }
      if (deploymentAttempted) {
        await this.#runtime.syncCommands(this.#runtime.registry).catch((rollbackError) => {
          rollbackFailures.push(`Discord rollback: ${safeErrorMessage(rollbackError)}`)
        })
      }
      throw new Error(
        `${safeErrorMessage(error)}${rollbackFailures.length > 0 ? `; ${rollbackFailures.join('; ')}` : ''}`,
        { cause: error }
      )
    }

    const remainingIds = new Set(next.map(({ id }) => id))
    const cleanupFailures: string[] = []
    for (const removed of previous.filter(({ id }) => !remainingIds.has(id))) {
      try {
        this.#runtime.cleanup?.(removed)
      } catch (error) {
        cleanupFailures.push(`${removed.id}: ${safeErrorMessage(error)}`)
      }
    }

    const result =
      input.action === 'remove'
        ? `Removed Discord feature ${input.id}.`
        : `${previous.some(({ id }) => id === input.id) ? 'Updated' : 'Created'} ${input.kind} Discord feature ${input.id} as ${input.kind === 'command' ? `/c ${input.name}` : input.name}.`
    return cleanupFailures.length > 0
      ? `${result} Cleanup needs repair: ${cleanupFailures.join('; ')}.`
      : result
  }

  #apply(features: StoredDiscordFeature[]): void {
    for (const name of this.#dynamicCommandNames) this.#runtime.subcommands.delete(name)
    this.#dynamicCommandNames.clear()
    this.#runtime.registry.unregister(DYNAMIC_FEATURE_REGISTRY_ID)

    const staticCommandNames = new Set(this.#runtime.subcommands.keys())
    const staticApplicationCommands = new Set(
      this.#runtime.registry.commands.map(
        (command) =>
          `${command.type ?? ApplicationCommandType.ChatInput}:${command.name.toLowerCase()}`
      )
    )
    for (const feature of features) {
      if (feature.kind === 'command' && staticCommandNames.has(feature.name)) {
        throw new Error(`/c command already registered: ${feature.name}`)
      }
      const type =
        feature.kind === 'user'
          ? ApplicationCommandType.User
          : feature.kind === 'message'
            ? ApplicationCommandType.Message
            : undefined
      if (type && staticApplicationCommands.has(`${type}:${feature.name.toLowerCase()}`)) {
        throw new Error(`application command already registered: ${type}:${feature.name}`)
      }
    }

    this.#features = structuredClone(features)
    for (const feature of features.filter(({ kind }) => kind === 'command')) {
      const subcommand: Subcommand = {
        name: feature.name,
        description: feature.description,
        usage: `${feature.name} [arguments] [--pub]`,
        examples: [feature.name],
        execute: async (interaction: CommandInteraction, args: string, flags: Flags) => {
          try {
            if (feature.code) {
              await deferCommandResponse(interaction, flags)
              const result = await executeDynamicJavascript(
                feature.code,
                args.replace(/^\S+\s*/, '').trim(),
                Object.fromEntries(flags)
              )
              const rawResponse = parseDynamicComponentsV2Response(result)
              if (rawResponse) {
                const message = await interaction.editReply({
                  components: rawResponse.components,
                  attachments: [],
                  flags: rawResponse.flags
                })
                if (!flags.has('pub')) {
                  scheduleEphemeralReplyDelete(interaction, message.id, MessageFlags.Ephemeral)
                }
                return
              }
              await sendCommandReply(
                interaction,
                commandContainer(
                  subcommand,
                  args,
                  flags,
                  text(formatDynamicJavascriptResult(result))
                )
              )
              return
            }
            await this.#runtime.run({
              feature,
              interaction,
              input: commandInvocation(args, flags),
              pub: flags.has('pub')
            })
          } catch (error) {
            if (!this.#runtime.recover) throw error
            await this.#runtime.recover(
              interaction,
              error,
              `dynamic /c ${args.slice(0, 500) || feature.name}`
            )
          }
        }
      }
      this.#runtime.subcommands.set(feature.name, subcommand)
      this.#dynamicCommandNames.add(feature.name)
    }

    const contextFeatures = features.filter(({ kind }) => kind !== 'command')
    this.#runtime.registry.register({
      id: DYNAMIC_FEATURE_REGISTRY_ID,
      priority: DYNAMIC_FEATURE_PRIORITY,
      commands: contextFeatures.map((feature) => ({
        name: feature.name,
        type:
          feature.kind === 'user' ? ApplicationCommandType.User : ApplicationCommandType.Message,
        integration_types: [0, 1],
        contexts: [0, 1, 2]
      })),
      matches: (interaction) => this.#matchingContextFeature(interaction) !== undefined,
      handle: async (interaction) => {
        if (!isAdminUser(interaction.user.id)) return
        const feature = this.#matchingContextFeature(interaction)
        if (!feature) return
        const repliable = interaction as RepliableInteraction
        try {
          await this.#runtime.run({
            feature,
            interaction: repliable,
            input: interaction.isUserContextMenuCommand()
              ? userInvocation(interaction)
              : messageInvocation(interaction as MessageContextMenuCommandInteraction),
            pub: false
          })
        } catch (error) {
          console.error(`dynamic Discord feature ${feature.id} failed`, error)
          if (this.#runtime.recover) {
            try {
              await this.#runtime.recover(
                repliable,
                error,
                `dynamic ${feature.kind} feature ${feature.name}`
              )
              return
            } catch (recoveryError) {
              console.error(`dynamic Discord feature ${feature.id} recovery failed`, recoveryError)
            }
          }
          const message = error instanceof Error ? error.message : String(error)
          const reply = errorContainer(feature.name, new Map(), message)
          if (repliable.deferred) {
            await repliable.editReply({
              components: reply.components,
              files: reply.files,
              attachments: [],
              flags: MessageFlags.IsComponentsV2
            })
          } else if (repliable.replied) {
            await repliable.followUp(reply)
          } else {
            await repliable.reply(reply)
          }
        }
      }
    })
  }

  #matchingContextFeature(interaction: Interaction): StoredDiscordFeature | undefined {
    if (interaction.isUserContextMenuCommand()) {
      return this.#features.find(
        ({ kind, name }) => kind === 'user' && name === interaction.commandName
      )
    }
    if (interaction.isMessageContextMenuCommand()) {
      return this.#features.find(
        ({ kind, name }) => kind === 'message' && name === interaction.commandName
      )
    }
    return undefined
  }
}

let activeManager: DynamicDiscordFeatureManager | undefined

export function setDynamicDiscordFeatureManager(
  manager: DynamicDiscordFeatureManager | undefined
): void {
  activeManager = manager
}

export async function manageDynamicDiscordFeatures(
  input: DynamicFeatureManagementInput
): Promise<string> {
  if (!activeManager) return 'Dynamic Discord feature management is unavailable.'
  return activeManager.manage(input)
}
