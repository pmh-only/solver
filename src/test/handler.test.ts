import { Collection } from 'discord.js'
import type { Interaction } from 'discord.js'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createHandler } from '../handler.js'
import type { Subcommand } from '../types.js'

const { handleAgentCommandMock } = vi.hoisted(() => ({
  handleAgentCommandMock: vi.fn()
}))

vi.mock('../commands/gpt.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../commands/gpt.js')>()),
  handleAgentCommand: handleAgentCommandMock
}))

afterEach(() => {
  vi.restoreAllMocks()
})

describe('/a error handling', () => {
  it('does not replace an acknowledged response with the generic error controls', async () => {
    handleAgentCommandMock.mockImplementationOnce(async (interaction) => {
      ;(interaction as { deferred: boolean }).deferred = true
      throw new Error('late agent failure')
    })
    vi.spyOn(console, 'error').mockImplementation(() => {})

    const editReply = vi.fn()
    const interaction = {
      user: { id: '666666666666666666' },
      commandName: 'a',
      deferred: false,
      replied: false,
      editReply,
      isAutocomplete: () => false,
      isMessageComponent: () => false,
      isModalSubmit: () => false,
      isButton: () => false,
      isStringSelectMenu: () => false,
      isUserContextMenuCommand: () => false,
      isMessageContextMenuCommand: () => false,
      isChatInputCommand: () => true
    } as unknown as Interaction

    await createHandler(new Collection<string, Subcommand>())(interaction)

    expect(handleAgentCommandMock).toHaveBeenCalledOnce()
    expect(editReply).not.toHaveBeenCalled()
  })
})
