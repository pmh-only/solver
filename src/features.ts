import { Collection, type Interaction } from 'discord.js'
import { additionalApplicationCommands, agentApplicationCommands } from './application-commands.js'
import { matchesInteractiveId } from './components.js'
import {
  AGENT_COMMAND_NAME,
  GPT_EFFORT_SELECT_ID,
  GPT_MODEL_SELECT_ID,
  GPT_VERBOSITY_SELECT_ID,
  isGptActionComponentId,
  isGptModalId
} from './agent/index.js'
import { DiscordFeatureRegistry, type DiscordFeature } from './feature-registry.js'
import { createHandler } from './handler.js'
import type { InteractionRecovery, Subcommand } from './types.js'

const CORE_FEATURE_PRIORITY = 100
const ADDITIONAL_FEATURE_PRIORITY = -100

function isAgentInteraction(interaction: Interaction): boolean {
  if (
    (interaction.isChatInputCommand() || interaction.isAutocomplete()) &&
    interaction.commandName === AGENT_COMMAND_NAME
  ) {
    return true
  }
  if (interaction.isMessageComponent() && isGptActionComponentId(interaction.customId)) {
    return true
  }
  if (interaction.isModalSubmit() && isGptModalId(interaction.customId)) return true
  if (!interaction.isStringSelectMenu()) return false

  return [GPT_MODEL_SELECT_ID, GPT_EFFORT_SELECT_ID, GPT_VERBOSITY_SELECT_ID].some((id) =>
    matchesInteractiveId(interaction.customId, id)
  )
}

export function createAgentFeature(
  handler: (interaction: Interaction) => Promise<void>
): DiscordFeature {
  return {
    id: 'agent',
    priority: CORE_FEATURE_PRIORITY,
    commands: agentApplicationCommands,
    matches: isAgentInteraction,
    handle: handler
  }
}

export function createAdditionalFeature(
  handler: (interaction: Interaction) => Promise<void>
): DiscordFeature {
  return {
    id: 'additional',
    priority: ADDITIONAL_FEATURE_PRIORITY,
    commands: additionalApplicationCommands,
    matches: () => true,
    handle: handler
  }
}

export function createFeatureRegistry(
  subcommands: Collection<string, Subcommand>,
  recover?: InteractionRecovery
): DiscordFeatureRegistry {
  const registry = new DiscordFeatureRegistry()
  const handler = createHandler(subcommands, recover)
  registry.register(createAgentFeature(handler))
  registry.register(createAdditionalFeature(handler))
  return registry
}
