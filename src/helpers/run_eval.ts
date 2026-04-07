import { Script, createContext } from 'node:vm'
import { inspect } from 'node:util'

const VM_TIMEOUT_MS = 200
const MAX_BLOCK_CHARS = 1500

export interface RunEvaluation {
  ok: boolean
  stdout?: string
  result?: string
  error?: string
  output: string
}

function formatValue(value: unknown): string {
  return inspect(value, {
    depth: 3,
    breakLength: 80,
    maxArrayLength: 20,
    maxStringLength: 500
  })
}

function trimBlock(text: string): string {
  if (text.length <= MAX_BLOCK_CHARS) return text
  return `${text.slice(0, MAX_BLOCK_CHARS - 14)}\n... truncated`
}

function asErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    if (/timed out/i.test(error.message)) return 'timeout'
    return `${error.name}: ${error.message}`
  }

  if (error && typeof error === 'object' && 'message' in error) {
    const message = String((error as { message: unknown }).message)
    if (/timed out/i.test(message)) return 'timeout'

    const name = 'name' in error ? String((error as { name?: unknown }).name ?? 'Error') : 'Error'
    return `${name}: ${message}`
  }

  return formatValue(error)
}

function block(label: string, body: string): string {
  return `**${label}**\n\n\`\`\`txt\n${trimBlock(body)}\n\`\`\``
}

export function evaluateJavaScript(source: string): RunEvaluation {
  const lines: string[] = []

  const write = (...args: unknown[]): void => {
    lines.push(args.map((arg) => formatValue(arg)).join(' '))
  }

  const context = createContext(
    {
      console: {
        log: (...args: unknown[]) => write(...args),
        info: (...args: unknown[]) => write(...args),
        warn: (...args: unknown[]) => write(...args),
        error: (...args: unknown[]) => write(...args),
        debug: (...args: unknown[]) => write(...args),
        dir: (value: unknown) => write(value)
      }
    },
    {
      codeGeneration: {
        strings: false,
        wasm: false
      }
    }
  )

  try {
    const result = new Script(source).runInContext(context, { timeout: VM_TIMEOUT_MS })
    const sections: string[] = []
    const stdout = lines.join('\n')
    const formattedResult = formatValue(result)

    if (lines.length > 0) {
      sections.push(block('out', stdout))
    }

    sections.push(block('res', formattedResult))

    return {
      ok: true,
      stdout: stdout || undefined,
      result: formattedResult,
      output: sections.join('\n\n')
    }
  } catch (error) {
    const sections: string[] = []
    const stdout = lines.join('\n')
    const message = asErrorMessage(error)

    if (lines.length > 0) {
      sections.push(block('out', stdout))
    }

    sections.push(block('err', message))

    return {
      ok: false,
      stdout: stdout || undefined,
      error: message,
      output: sections.join('\n\n')
    }
  }
}
