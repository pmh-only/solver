import { Collection, ComponentType, MessageFlags } from 'discord.js'
import type { Interaction } from 'discord.js'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createHandler } from '../handler.js'
import type { Subcommand } from '../types.js'

const { handleAgentCommandMock, isAgentMcpRuntimeInitializingMock } = vi.hoisted(() => ({
  handleAgentCommandMock: vi.fn(),
  isAgentMcpRuntimeInitializingMock: vi.fn(() => false)
}))

vi.mock('../agent/index.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../agent/index.js')>()),
  handleAgentCommand: handleAgentCommandMock,
  isAgentMcpRuntimeInitializing: isAgentMcpRuntimeInitializingMock
}))

beforeEach(() => {
  handleAgentCommandMock.mockReset()
  isAgentMcpRuntimeInitializingMock.mockReset()
  isAgentMcpRuntimeInitializingMock.mockReturnValue(false)
})

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
      embeds: [],
      components: [{ type: ComponentType.TextDisplay, content: 'error: agent startup failed' }],
      attachments: [],
      flags: MessageFlags.IsComponentsV2,
      allowedMentions: { parse: [] }
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
      embeds: [],
      components: [{ type: ComponentType.TextDisplay, content: 'error: late agent failure' }],
      attachments: [],
      flags: MessageFlags.IsComponentsV2,
      allowedMentions: { parse: [] }
    })
  })

  it('blocks the command while MCP services are starting', async () => {
    isAgentMcpRuntimeInitializingMock.mockReturnValue(true)
    const reply = vi.fn()
    const interaction = agentInteraction({ reply })

    await createHandler(new Collection<string, Subcommand>())(interaction)

    expect(handleAgentCommandMock).not.toHaveBeenCalled()
    expect(reply).toHaveBeenCalledWith({
      embeds: [],
      components: [
        {
          type: ComponentType.TextDisplay,
          content: 'MCP services are still starting. Try `/a` again shortly.'
        }
      ],
      flags: MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral,
      allowedMentions: { parse: [] }
    })
  })

  it('returns no autocomplete choices while MCP services are starting', async () => {
    isAgentMcpRuntimeInitializingMock.mockReturnValue(true)
    const respond = vi.fn()
    const interaction = agentInteraction({
      isAutocomplete: () => true,
      isChatInputCommand: () => false,
      respond,
      responded: false
    })

    await createHandler(new Collection<string, Subcommand>())(interaction)

    expect(respond).toHaveBeenCalledWith([])
    expect(handleAgentCommandMock).not.toHaveBeenCalled()
  })
})
