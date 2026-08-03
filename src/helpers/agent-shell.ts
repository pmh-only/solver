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
  timeoutMs = DEFAULT_TIMEOUT_MS,
  signal?: AbortSignal
): Promise<AgentShellResult> {
  return await new Promise((resolve) => {
    const child = spawn('/bin/bash', ['-lc', command], {
      cwd: process.cwd(),
      detached: true,
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe']
    })
    let stdout = ''
    let stderr = ''
    let timedOut = false

    const terminate = () => {
      try {
        if (child.pid) process.kill(-child.pid, 'SIGKILL')
        else child.kill('SIGKILL')
      } catch {
        child.kill('SIGKILL')
      }
    }
    const abort = () => terminate()
    if (signal?.aborted) abort()
    else signal?.addEventListener('abort', abort, { once: true })

    child.stdout.on('data', (chunk: string | Buffer) => {
      stdout = appendOutput(stdout, String(chunk))
    })
    child.stderr.on('data', (chunk: string | Buffer) => {
      stderr = appendOutput(stderr, String(chunk))
    })

    const timer = setTimeout(() => {
      timedOut = true
      terminate()
    }, timeoutMs)

    child.on('error', (error) => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', abort)
      resolve({ exitCode: null, stdout, stderr: appendOutput(stderr, error.message), timedOut })
    })
    child.on('close', (exitCode) => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', abort)
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
