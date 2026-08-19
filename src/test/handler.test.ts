import { Collection } from 'discord.js'
import type { Interaction } from 'discord.js'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createHandler } from '../handler.js'
import type { Subcommand } from '../types.js'

const { handleAgentCommandMock } = vi.hoisted(() => ({
  handleAgentCommandMock: vi.fn()
}))

vi.mock('../agent/index.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../agent/index.js')>()),
  handleAgentCommand: handleAgentCommandMock
}))

afterEach(() => {
  vi.restoreAllMocks()
})

describe('/a error handling', () => {
  function agentInteraction(overrides: Record<string, unknown> = {}) {
    return {
      user: { id: '666666666666666666' },
      commandName: 'a',
      deferred: false,
      replied: false,
      editReply: vi.fn(),
      followUp: vi.fn(),
      reply: vi.fn(),
      isAutocomplete: () => false,
      isMessageComponent: () => false,
      isModalSubmit: () => false,
      isButton: () => false,
      isStringSelectMenu: () => false,
      isUserContextMenuCommand: () => false,
      isMessageContextMenuCommand: () => false,
      isChatInputCommand: () => true,
      ...overrides
    } as unknown as Interaction
  }

  it('displays an error directly when the command fails before acknowledgement', async () => {
    handleAgentCommandMock.mockRejectedValueOnce(new Error('agent startup failed'))
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const reply = vi.fn()
    const interaction = agentInteraction({ reply })

    await createHandler(new Collection<string, Subcommand>())(interaction)

    expect(reply).toHaveBeenCalledWith({
      content: 'error: agent startup failed',
      embeds: [],
      components: [],
      attachments: []
    })
  })

  it('displays an error directly when the command fails after deferring', async () => {
    handleAgentCommandMock.mockImplementationOnce(async (interaction) => {
      ;(interaction as { deferred: boolean }).deferred = true
      throw new Error('late agent failure')
    })
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const editReply = vi.fn()
    const interaction = agentInteraction({ editReply })

    await createHandler(new Collection<string, Subcommand>())(interaction)

    expect(editReply).toHaveBeenCalledWith({
      content: 'error: late agent failure',
      embeds: [],
      components: [],
      attachments: []
    })
  })
})
