import type { Client } from 'discord.js'
import {
  closeAgentMcpRuntime,
  initializeAgentMcpRuntime
} from './agent/index.js'
import { restoreLyricsSession } from './commands/lyrics.js'
import { clearRuntimeIssue, reportRuntimeIssue } from './runtime-health.js'
import { safeErrorMessage } from './safe-error.js'

interface BotReadyDependencies {
  initializeMcp: () => Promise<void>
  closeMcp: () => Promise<void>
  restoreLyrics: (client: Client) => Promise<boolean>
  clearIssue: (source: string) => void
  reportIssue: (source: string, error: unknown) => void
  log: (message: string) => void
  logError: (message: string) => void
}

const defaultDependencies: BotReadyDependencies = {
  initializeMcp: initializeAgentMcpRuntime,
  closeMcp: closeAgentMcpRuntime,
  restoreLyrics: restoreLyricsSession,
  clearIssue: clearRuntimeIssue,
  reportIssue: reportRuntimeIssue,
  log: (message) => console.log(message),
  logError: (message) => console.error(message)
}

export async function initializeBotReadyServices(
  client: Client,
  dependencies: Partial<BotReadyDependencies> = {}
): Promise<void> {
  const deps = { ...defaultDependencies, ...dependencies }
  try {
    await deps.initializeMcp()
    deps.clearIssue('agent_mcp_startup')
  } catch (error) {
    deps.reportIssue('agent_mcp_startup', error)
    deps.logError(`agent MCP startup failed safely: ${safeErrorMessage(error)}`)
    await deps.closeMcp()
    return
  }

  try {
    if (await deps.restoreLyrics(client)) deps.log('restored live lyrics session')
  } catch (error) {
    deps.logError(`failed to restore live lyrics session: ${safeErrorMessage(error)}`)
  }
}
