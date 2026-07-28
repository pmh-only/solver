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
})
