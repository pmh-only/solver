import { clearRuntimeIssue, reportRuntimeIssue } from '../../../shared/runtime/health.js'

const INTERVAL_MS = 5_000
const RETRY_MS = 30_000
const MAX_RETRY_MS = 5 * 60_000
const ISSUE =
  'Automatic history collection paused; check channel permissions and storage through /a. Saved progress will be retried.'

// Run one bounded page at a time, leaving idle time for searches and realtime writes.
export class DiscordArchiveHistoryWorker {
  private timer?: ReturnType<typeof setTimeout>
  private running?: Promise<void>
  private controller?: AbortController
  private closed = false
  private failures = 0
  issue: string | null = null

  constructor(
    private readonly step: (signal: AbortSignal) => Promise<boolean>,
    private readonly automatic = true
  ) {}

  start() {
    if (!this.automatic || this.closed || this.timer || this.running) return
    this.schedule(INTERVAL_MS)
  }

  private schedule(delay: number) {
    if (this.closed) return
    this.timer = setTimeout(() => {
      this.timer = undefined
      this.controller = new AbortController()
      const signal = AbortSignal.any([this.controller.signal, AbortSignal.timeout(20_000)])
      this.running = this.run(signal).finally(() => {
        this.running = undefined
        this.controller = undefined
        this.schedule(
          this.failures ? Math.min(RETRY_MS * 2 ** (this.failures - 1), MAX_RETRY_MS) : INTERVAL_MS
        )
      })
      return this.running
    }, delay)
    this.timer.unref()
  }

  private async run(signal: AbortSignal) {
    try {
      if (await this.step(signal)) {
        this.failures = 0
        this.issue = null
        clearRuntimeIssue('discord_archive_history')
      }
    } catch {
      if (this.closed) return
      this.failures = Math.min(this.failures + 1, 5)
      this.issue = ISSUE
      // Never publish API errors, message text or credentials in health output.
      reportRuntimeIssue('discord_archive_history', new Error(ISSUE))
    }
  }

  async close() {
    this.closed = true
    if (this.timer) clearTimeout(this.timer)
    this.timer = undefined
    this.controller?.abort()
    await this.running
  }
}
