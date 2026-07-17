import { describe, expect, it, vi } from 'vitest'
import { ApplicationCommandType, Routes, type REST } from 'discord.js'
import { applicationCommands } from '../application-commands.js'
import {
  replaceApplicationCommands,
  staleEntryPointCommands,
  type RegisteredApplicationCommand
} from '../application-command-deployment.js'

const CLIENT_ID = '999999999999999999'

function currentCommands(): RegisteredApplicationCommand[] {
  return applicationCommands.map((command, index) => ({
    id: String(index + 1),
    name: command.name,
    type: command.type ?? ApplicationCommandType.ChatInput
  }))
}

describe('application command deployment', () => {
  it('deletes a stale Entry Point before the bulk update', async () => {
    const entryPoint = {
      id: '888888888888888888',
      name: 'Launch',
      type: ApplicationCommandType.PrimaryEntryPoint
    }
    const deleteMock = vi.fn(async () => ({}))
    const putMock = vi.fn(async () => [])
    const rest = { delete: deleteMock, put: putMock } as unknown as Pick<REST, 'delete' | 'put'>

    await replaceApplicationCommands(rest, CLIENT_ID, [...currentCommands(), entryPoint])

    expect(deleteMock).toHaveBeenCalledWith(Routes.applicationCommand(CLIENT_ID, entryPoint.id))
    expect(putMock).toHaveBeenCalledWith(Routes.applicationCommands(CLIENT_ID), {
      body: applicationCommands
    })
    expect(deleteMock.mock.invocationCallOrder[0]).toBeLessThan(
      putMock.mock.invocationCallOrder[0]!
    )
  })

  it('does not separately delete ordinary stale commands', async () => {
    const ordinary = {
      id: '777777777777777777',
      name: 'obsolete',
      type: ApplicationCommandType.ChatInput
    }

    expect(staleEntryPointCommands([...currentCommands(), ordinary])).toEqual([])
  })
})
