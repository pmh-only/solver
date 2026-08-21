import { spawn } from 'node:child_process'

const EXECUTION_TIMEOUT_MS = 1_000
const MAX_OUTPUT_BYTES = 16 * 1024

const RUNNER = String.raw`
import vm from 'node:vm'

let input = ''
for await (const chunk of process.stdin) input += chunk
const { code, args, flags } = JSON.parse(input)
const context = vm.createContext(Object.freeze({ args, flags }), {
  codeGeneration: { strings: false, wasm: false }
})
const script = new vm.Script('(async () => { "use strict";\n' + code + '\n})()')
const result = await script.runInContext(context, { timeout: 500 })
process.stdout.write(JSON.stringify({ result }))
`

export async function executeDynamicJavascript(
  code: string,
  args: string,
  flags: Record<string, boolean | string>
): Promise<unknown> {
  return await new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [
        '--permission',
        '--max-old-space-size=32',
        '--input-type=module',
        '--eval',
        RUNNER
      ],
      { env: {}, stdio: ['pipe', 'pipe', 'pipe'] }
    )
    let stdout: Buffer<ArrayBufferLike> = Buffer.alloc(0)
    let stderr: Buffer<ArrayBufferLike> = Buffer.alloc(0)
    let settled = false

    const finish = (error?: Error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (error) reject(error)
    }
    const append = (
      current: Buffer<ArrayBufferLike>,
      chunk: Buffer<ArrayBufferLike>
    ): Buffer<ArrayBufferLike> =>
      Buffer.concat([current, chunk]).subarray(0, MAX_OUTPUT_BYTES) as Buffer

    child.stdout.on('data', (chunk: Buffer) => {
      stdout = append(stdout, chunk)
      if (stdout.length >= MAX_OUTPUT_BYTES) {
        child.kill('SIGKILL')
        finish(new Error('JavaScript command output exceeded the limit'))
      }
    })
    child.stderr.on('data', (chunk: Buffer) => {
      stderr = append(stderr, chunk)
    })
    child.on('error', (error) => finish(error))
    child.on('close', (exitCode) => {
      if (settled) return
      clearTimeout(timer)
      settled = true
      if (exitCode !== 0) {
        reject(new Error(stderr.toString('utf8').trim() || 'JavaScript command failed'))
        return
      }
      try {
        resolve((JSON.parse(stdout.toString('utf8')) as { result?: unknown }).result)
      } catch {
        reject(new Error('JavaScript command returned an invalid result'))
      }
    })

    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      finish(new Error('JavaScript command timed out'))
    }, EXECUTION_TIMEOUT_MS)
    timer.unref?.()
    child.stdin.end(JSON.stringify({ code, args, flags }))
  })
}

export function formatDynamicJavascriptResult(result: unknown): string {
  if (typeof result === 'string') return result.slice(0, 3_900)
  if (result === undefined) return '(no output)'
  const serialized = JSON.stringify(result, null, 2)
  return (serialized ?? String(result)).slice(0, 3_900)
}
