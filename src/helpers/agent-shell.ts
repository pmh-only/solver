import { spawn } from 'node:child_process'

const MAX_OUTPUT_CHARS = 64 * 1024
const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000

export interface AgentShellResult {
  exitCode: number | null
  stdout: string
  stderr: string
  timedOut: boolean
}

function appendOutput(current: string, chunk: string): string {
  if (current.length >= MAX_OUTPUT_CHARS) return current
  return current + chunk.slice(0, MAX_OUTPUT_CHARS - current.length)
}

export async function executeAgentShell(
  command: string,
  timeoutMs = DEFAULT_TIMEOUT_MS
): Promise<AgentShellResult> {
  return await new Promise((resolve) => {
    const child = spawn('/bin/bash', ['-lc', command], {
      cwd: process.cwd(),
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe']
    })
    let stdout = ''
    let stderr = ''
    let timedOut = false

    child.stdout.on('data', (chunk: string | Buffer) => {
      stdout = appendOutput(stdout, String(chunk))
    })
    child.stderr.on('data', (chunk: string | Buffer) => {
      stderr = appendOutput(stderr, String(chunk))
    })

    const timer = setTimeout(() => {
      timedOut = true
      child.kill('SIGKILL')
    }, timeoutMs)

    child.on('error', (error) => {
      clearTimeout(timer)
      resolve({ exitCode: null, stdout, stderr: appendOutput(stderr, error.message), timedOut })
    })
    child.on('close', (exitCode) => {
      clearTimeout(timer)
      resolve({ exitCode, stdout, stderr, timedOut })
    })
  })
}

export function formatAgentShellResult(result: AgentShellResult): string {
  const sections = [
    result.timedOut ? 'Timed out and terminated.' : `Exit code: ${result.exitCode ?? 'unavailable'}`
  ]
  if (result.stdout) sections.push(`stdout:\n${result.stdout}`)
  if (result.stderr) sections.push(`stderr:\n${result.stderr}`)
  return sections.join('\n\n')
}
