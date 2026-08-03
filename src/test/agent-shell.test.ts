import { describe, expect, it } from 'vitest'
import { executeAgentShell, formatAgentShellResult } from '../helpers/agent-shell.js'

describe('agent shell', () => {
  it('runs a command through bash and returns both output streams', async () => {
    const result = await executeAgentShell('printf stdout; printf stderr >&2')

    expect(result).toEqual({
      exitCode: 0,
      stdout: 'stdout',
      stderr: 'stderr',
      timedOut: false
    })
    expect(formatAgentShellResult(result)).toBe(
      'Exit code: 0\n\nstdout:\nstdout\n\nstderr:\nstderr'
    )
  })

  it('terminates commands after the requested timeout', async () => {
    const result = await executeAgentShell('sleep 1', 10)

    expect(result.timedOut).toBe(true)
    expect(result.exitCode).toBeNull()
  })

  it('terminates commands when the request is aborted', async () => {
    const controller = new AbortController()
    const startedAt = Date.now()
    const result = executeAgentShell('sleep 10 & wait', 60_000, controller.signal)
    controller.abort()

    await expect(result).resolves.toMatchObject({ exitCode: null, timedOut: false })
    expect(Date.now() - startedAt).toBeLessThan(1_000)
  })
})
