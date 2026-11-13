import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DiscordArchiveHistoryWorker } from '../../../../features/archive/capture/history.js'
import {
  clearRuntimeIssuesForTests,
  runtimeIssueSummary
} from '../../../../shared/runtime/health.js'

let worker: DiscordArchiveHistoryWorker
const step = vi.fn<(signal: AbortSignal) => Promise<boolean>>()

beforeEach(() => {
  vi.useFakeTimers()
  vi.resetAllMocks()
  clearRuntimeIssuesForTests()
  step.mockResolvedValue(true)
  worker = new DiscordArchiveHistoryWorker(step)
})
afterEach(async () => {
  await worker.close()
  vi.useRealTimers()
  clearRuntimeIssuesForTests()
})

describe('automatic archive history scheduling', () => {
  it('waits between bounded pages and starts only one loop', async () => {
    worker.start()
    worker.start()
    await vi.advanceTimersByTimeAsync(4999)
    expect(step).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(step).toHaveBeenCalledOnce()
    expect(step.mock.calls[0]![0]).toBeInstanceOf(AbortSignal)
    await vi.advanceTimersByTimeAsync(4999)
    expect(step).toHaveBeenCalledOnce()
    await vi.advanceTimersByTimeAsync(1)
    expect(step).toHaveBeenCalledTimes(2)
  })

  it('does not overlap slow pages or repeated starts', async () => {
    let finish!: (attempted: boolean) => void
    step.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve
        })
    )
    worker.start()
    await vi.advanceTimersByTimeAsync(5000)
    worker.start()
    await vi.advanceTimersByTimeAsync(15000)
    expect(step).toHaveBeenCalledOnce()
    finish(true)
    await vi.advanceTimersByTimeAsync(0)
    await vi.advanceTimersByTimeAsync(5000)
    expect(step).toHaveBeenCalledTimes(2)
  })

  it('retries with capped exponential backoff and redacted health warnings', async () => {
    step.mockRejectedValue(new Error('secret-discord-token'))
    worker.start()
    await vi.advanceTimersByTimeAsync(5000)
    expect(step).toHaveBeenCalledOnce()
    expect(worker.issue).toContain('permissions and storage')
    expect(runtimeIssueSummary()).toContain('discord_archive_history')
    expect(runtimeIssueSummary()).not.toContain('secret-discord-token')
    for (const delay of [30000, 60000, 120000, 240000, 300000, 300000]) {
      const calls = step.mock.calls.length
      await vi.advanceTimersByTimeAsync(delay - 1)
      expect(step).toHaveBeenCalledTimes(calls)
      await vi.advanceTimersByTimeAsync(1)
      expect(step).toHaveBeenCalledTimes(calls + 1)
    }
    step.mockResolvedValueOnce(true)
    await vi.advanceTimersByTimeAsync(300000)
    expect(worker.issue).toBeNull()
    expect(runtimeIssueSummary()).toBe('')
    const calls = step.mock.calls.length
    await vi.advanceTimersByTimeAsync(5000)
    expect(step).toHaveBeenCalledTimes(calls + 1)
  })

  it('keeps prior failures visible when disabled or idle rather than pretending recovery', async () => {
    step.mockRejectedValueOnce(new Error('storage full')).mockResolvedValue(false)
    worker.start()
    await vi.advanceTimersByTimeAsync(5000)
    await vi.advanceTimersByTimeAsync(30000)
    expect(worker.issue).not.toBeNull()
    expect(runtimeIssueSummary()).toContain('discord_archive_history')
  })

  it('aborts and waits for an in-flight page on shutdown without scheduling again', async () => {
    let signal!: AbortSignal
    let finish!: (attempted: boolean) => void
    step.mockImplementationOnce((input) => {
      signal = input
      return new Promise((resolve) => {
        finish = resolve
      })
    })
    worker.start()
    await vi.advanceTimersByTimeAsync(5000)
    const closed = worker.close()
    expect(signal.aborted).toBe(true)
    finish(true)
    await closed
    worker.start()
    await vi.advanceTimersByTimeAsync(60000)
    expect(step).toHaveBeenCalledOnce()
  })

  it('cancels queued work on shutdown and honors explicit manual-only construction', async () => {
    worker.start()
    await worker.close()
    await vi.advanceTimersByTimeAsync(5000)
    expect(step).not.toHaveBeenCalled()
    worker = new DiscordArchiveHistoryWorker(step, false)
    worker.start()
    await vi.advanceTimersByTimeAsync(60000)
    expect(step).not.toHaveBeenCalled()
  })
})
