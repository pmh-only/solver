import { REST, Routes } from 'discord.js'
import { applicationCommands } from './application-commands.js'

const PRIMARY_ENTRY_POINT_COMMAND_TYPE = 4

export interface RegisteredApplicationCommand {
  id: string
  name: string
  type: number
}

export function staleEntryPointCommands(
  existing: RegisteredApplicationCommand[]
): RegisteredApplicationCommand[] {
  const desired = new Set(
    applicationCommands.map((command) => `${command.type ?? 1}:${command.name}`)
  )
  return existing.filter(
    (command) =>
      command.type === PRIMARY_ENTRY_POINT_COMMAND_TYPE &&
      !desired.has(`${command.type}:${command.name}`)
  )
}

export async function replaceApplicationCommands(
  rest: Pick<REST, 'delete' | 'put'>,
  clientId: string,
  existing: RegisteredApplicationCommand[]
): Promise<unknown> {
  for (const command of staleEntryPointCommands(existing)) {
    await rest.delete(Routes.applicationCommand(clientId, command.id))
  }

  return rest.put(Routes.applicationCommands(clientId), {
    body: applicationCommands
  })
}
