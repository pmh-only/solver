import { describe, expect, it } from 'vitest'
import {
  executeDynamicJavascript,
  formatDynamicJavascriptResult
} from '../helpers/dynamic-javascript.js'

describe('dynamic JavaScript commands', () => {
  it('executes code with command arguments and flags', async () => {
    const result = await executeDynamicJavascript(
      'return `${args}:${flags.loud ? "!" : "."}`',
      'hello',
      { loud: true }
    )

    expect(result).toBe('hello:!')
  })

  it('does not expose Node globals to command code', async () => {
    await expect(
      executeDynamicJavascript('return process.env', '', {})
    ).rejects.toThrow('process is not defined')
    await expect(
      executeDynamicJavascript('return fetch("https://example.com")', '', {})
    ).rejects.toThrow('fetch is not defined')
  })

  it('terminates unbounded code', async () => {
    await expect(executeDynamicJavascript('while (true) {}', '', {})).rejects.toThrow(
      /timed out|Script execution timed out/
    )
  })

  it('formats strings and structured return values for Discord', () => {
    expect(formatDynamicJavascriptResult('안녕')).toBe('안녕')
    expect(formatDynamicJavascriptResult({ ok: true })).toBe('{\n  "ok": true\n}')
    expect(formatDynamicJavascriptResult(undefined)).toBe('(no output)')
  })
})
