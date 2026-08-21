import { ApplicationCommandType, type Interaction } from 'discord.js'
import type { InteractionRecovery } from './types.js'

export interface ApplicationCommandDefinition {
  name: string
  type?: number
  description?: string
  options?: readonly {
    name: string
    type: number
    description: string
    required?: boolean
    autocomplete?: boolean
    max_length?: number
  }[]
  [key: string]: unknown
}

export interface DiscordFeature {
  id: string
  priority?: number
  commands: readonly ApplicationCommandDefinition[]
  matches: (interaction: Interaction) => boolean
  handle: (interaction: Interaction) => Promise<void>
}

export function restrictApplicationCommands(
  commands: readonly ApplicationCommandDefinition[]
): ApplicationCommandDefinition[] {
  return commands.map((command) => ({ ...command, default_member_permissions: '0' }))
}

export class DiscordFeatureRegistry {
  readonly #features = new Map<string, DiscordFeature>()

  register(feature: DiscordFeature): void {
    if (this.#features.has(feature.id)) {
      throw new Error(`feature already registered: ${feature.id}`)
    }

    const commandKeys = new Set(this.commands.map(commandKey))
    for (const command of feature.commands) {
      const key = commandKey(command)
      if (commandKeys.has(key)) throw new Error(`application command already registered: ${key}`)
      commandKeys.add(key)
    }

    this.#features.set(feature.id, feature)
  }

  unregister(id: string): boolean {
    return this.#features.delete(id)
  }

  get commands(): ApplicationCommandDefinition[] {
    return restrictApplicationCommands(
      this.#orderedFeatures().flatMap((feature) => [...feature.commands])
    )
  }

  createHandler(recover?: InteractionRecovery): (interaction: Interaction) => Promise<void> {
    return async (interaction) => {
      let feature: DiscordFeature | undefined
      try {
        feature = this.#orderedFeatures().find((candidate) => candidate.matches(interaction))
        if (feature) await feature.handle(interaction)
      } catch (error) {
        console.error(`Discord feature ${feature?.id ?? 'matcher'} failed`, error)
        if (recover) {
          await recover(interaction, error, feature?.id ?? 'feature matcher').catch(
            (recoveryError) => {
              console.error('Discord feature recovery failed', recoveryError)
            }
          )
        }
      }
    }
  }

  #orderedFeatures(): DiscordFeature[] {
    return [...this.#features.values()].sort(
      (left, right) => (right.priority ?? 0) - (left.priority ?? 0)
    )
  }
}

function commandKey(command: ApplicationCommandDefinition): string {
  return `${command.type ?? ApplicationCommandType.ChatInput}:${command.name}`
}
