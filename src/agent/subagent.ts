import { Agent, tool, type Tool } from '@strands-agents/sdk'
import { z } from 'zod'
import { safeErrorMessage } from '../safe-error.js'

export const MAX_PARALLEL_SUBAGENTS = 4
const MAX_SUBAGENT_TASK_LENGTH = 8_000
const MAX_SUBAGENT_RESULT_LENGTH = 8_000
const MAX_SUBAGENT_TURNS = 8

interface SubagentToolOptions {
  createAgent: () => Agent
  signal: AbortSignal
  tokenLimit: number
}

export function createSubagentTool({ createAgent, signal, tokenLimit }: SubagentToolOptions): Tool {
  return tool({
    name: 'delegate_tasks',
    description:
      'Run up to four independent tasks concurrently using fresh copies of this agent. Use one task per independent workstream, then combine the returned findings into the final answer. Sub-agents cannot delegate again.',
    inputSchema: z.object({
      tasks: z
        .array(
          z.object({
            task: z
              .string()
              .min(1)
              .max(MAX_SUBAGENT_TASK_LENGTH)
              .describe('A self-contained task with the context needed to complete it')
          })
        )
        .min(1)
        .max(MAX_PARALLEL_SUBAGENTS)
        .describe('Independent tasks to execute concurrently')
    }),
    callback: async ({ tasks }) => {
      const agents = tasks.map(() => createAgent())
      const cancel = () => agents.forEach((agent) => agent.cancel())
      signal.addEventListener('abort', cancel, { once: true })

      try {
        const results = await Promise.allSettled(
          tasks.map(({ task }, index) =>
            agents[index]!.invoke(task, {
              cancelSignal: signal,
              limits: { turns: MAX_SUBAGENT_TURNS, totalTokens: tokenLimit }
            })
          )
        )

        return JSON.stringify(
          results.map((result, index) => ({
            task: index + 1,
            ...(result.status === 'fulfilled'
              ? {
                  status: result.value.stopReason === 'cancelled' ? 'cancelled' : 'success',
                  result: result.value.toString().slice(0, MAX_SUBAGENT_RESULT_LENGTH)
                }
              : { status: 'error', error: safeErrorMessage(result.reason) })
          }))
        )
      } finally {
        signal.removeEventListener('abort', cancel)
      }
    }
  })
}
