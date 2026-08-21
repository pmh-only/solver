import { REST, Routes } from 'discord.js'
import { applicationCommands } from './application-commands.js'
import type { ApplicationCommandDefinition } from './feature-registry.js'

const PRIMARY_ENTRY_POINT_COMMAND_TYPE = 4

export interface RegisteredApplicationCommand {
  id: string
  name: string
  type: number
  description?: string
  default_member_permissions?: string | null
  options?: Array<{
    name: string
    type: number
    description: string
    required?: boolean
    autocomplete?: boolean
    max_length?: number
  }>
}

export function staleEntryPointCommands(
  existing: RegisteredApplicationCommand[],
  desiredCommands: readonly ApplicationCommandDefinition[] = applicationCommands
): RegisteredApplicationCommand[] {
  const desired = new Set(desiredCommands.map((command) => `${command.type ?? 1}:${command.name}`))
  return existing.filter(
    (command) =>
      command.type === PRIMARY_ENTRY_POINT_COMMAND_TYPE &&
      !desired.has(`${command.type}:${command.name}`)
  )
}

export async function replaceApplicationCommands(
  rest: Pick<REST, 'delete' | 'put'>,
  clientId: string,
  existing: RegisteredApplicationCommand[],
  desiredCommands: readonly ApplicationCommandDefinition[] = applicationCommands
): Promise<unknown> {
  for (const command of staleEntryPointCommands(existing, desiredCommands)) {
    await rest.delete(Routes.applicationCommand(clientId, command.id))
  }

  return rest.put(Routes.applicationCommands(clientId), {
    body: desiredCommands
  })
}
