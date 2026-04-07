import { spawn } from 'node:child_process'

const MAX_OUTPUT_CHARS = 1500
const SHELL_TIMEOUT_MS = 3000

export interface ShellResult {
  ok: boolean
  output: string
}

function appendChunk(current: string, chunk: string): string {
  if (current.length >= MAX_OUTPUT_CHARS) return current
  return current + chunk.slice(0, MAX_OUTPUT_CHARS - current.length)
}

function trimOutput(text: string): string {
  if (text.length <= MAX_OUTPUT_CHARS) return text
  return `${text.slice(0, MAX_OUTPUT_CHARS - 14)}\n... truncated`
}

function block(label: string, body: string): string {
  return `**${label}**\n\n\`\`\`txt\n${trimOutput(body)}\n\`\`\``
}

export async function executeShell(input: string): Promise<ShellResult> {
  const source = input.trim()
  if (!source) {
    return { ok: false, output: 'no cmd' }
  }

  return await new Promise((resolve) => {
    const child = spawn('sh', ['-c', source], {
      stdio: ['ignore', 'pipe', 'pipe']
    })

    let out = ''
    let err = ''
    let timedOut = false

    const timer = setTimeout(() => {
      timedOut = true
      child.kill('SIGKILL')
    }, SHELL_TIMEOUT_MS)

    child.stdout.on('data', (chunk: string | Buffer) => {
      out = appendChunk(out, String(chunk))
    })

    child.stderr.on('data', (chunk: string | Buffer) => {
      err = appendChunk(err, String(chunk))
    })

    child.on('error', () => {
      clearTimeout(timer)
      resolve({ ok: false, output: 'shell err' })
    })

    child.on('close', (code) => {
      clearTimeout(timer)

      if (timedOut) {
        resolve({ ok: false, output: 'timeout' })
        return
      }

      const sections: string[] = []
      if (out) sections.push(block('out', out))
      if (err) sections.push(block('err', err))
      sections.push(`-# code ${code ?? 0}`)

      resolve({
        ok: code === 0,
        output: sections.join('\n\n') || '-# code 0'
      })
    })
  })
}
