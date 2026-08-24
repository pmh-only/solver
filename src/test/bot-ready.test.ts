import type { Client } from 'discord.js'
import { describe, expect, it, vi } from 'vitest'
import { initializeBotReadyServices } from '../bot-ready.js'

describe('post-ready service startup', () => {
  const client = {} as Client

  it('initializes MCP before restoring a persisted lyrics card', async () => {
    const order: string[] = []
    const clearIssue = vi.fn()
    const log = vi.fn()

    await initializeBotReadyServices(client, {
      initializeMcp: async () => {
        order.push('mcp')
      },
      waitForMcpServer: async (serverName) => {
        expect(serverName).toBe('spotify')
        order.push('spotify')
      },
      restoreLyrics: async (receivedClient) => {
        expect(receivedClient).toBe(client)
        order.push('lyrics')
        return true
      },
      clearIssue,
      log
    })

    expect(order).toEqual(['mcp', 'spotify', 'lyrics'])
    expect(clearIssue).toHaveBeenCalledWith('agent_mcp_startup')
    expect(log).toHaveBeenCalledWith('restored live lyrics session')
  })

  it('does not attempt lyrics restoration when MCP startup fails', async () => {
    const startupError = new Error('boot failed')
    const restoreLyrics = vi.fn(async () => true)
    const closeMcp = vi.fn(async () => undefined)
    const reportIssue = vi.fn()
    const logError = vi.fn()

    await initializeBotReadyServices(client, {
      initializeMcp: async () => {
        throw startupError
      },
      waitForMcpServer: async () => {
        throw startupError
      },
      closeMcp,
      restoreLyrics,
      reportIssue,
      logError
    })

    expect(reportIssue).toHaveBeenCalledWith('agent_mcp_startup', startupError)
    expect(closeMcp).toHaveBeenCalledOnce()
    expect(restoreLyrics).not.toHaveBeenCalled()
    expect(logError).toHaveBeenCalledWith('agent MCP startup failed safely: boot failed')
  })

  it('restores lyrics after Spotify is ready without waiting for every MCP server', async () => {
    let finishMcpStartup!: () => void
    const mcpStartup = new Promise<void>((resolve) => {
      finishMcpStartup = resolve
    })
    const restoreLyrics = vi.fn(async () => true)
    const startup = initializeBotReadyServices(client, {
      initializeMcp: () => mcpStartup,
      waitForMcpServer: async (serverName) => {
        expect(serverName).toBe('spotify')
      },
      restoreLyrics
    })

    await vi.waitFor(() => expect(restoreLyrics).toHaveBeenCalledOnce())
    let completed = false
    void startup.then(() => {
      completed = true
    })
    await Promise.resolve()
    expect(completed).toBe(false)

    finishMcpStartup()
    await startup
  })
})
