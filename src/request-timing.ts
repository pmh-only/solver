import { performance } from 'node:perf_hooks'

export interface TimingEntry {
  name: string
  startMs: number
  durationMs?: number
}

export interface TimingSnapshot {
  totalMs: number
  entries: TimingEntry[]
}

export class RequestTiming {
  readonly startedAt: number
  private readonly entries: TimingEntry[] = []

  constructor(startedAt = performance.now()) {
    this.startedAt = startedAt
  }

  now(): number {
    return performance.now()
  }

  mark(name: string): void {
    this.entries.push({ name, startMs: this.now() - this.startedAt })
  }

  span(name: string, startedAt: number): void {
    this.entries.push({
      name,
      startMs: startedAt - this.startedAt,
      durationMs: this.now() - startedAt
    })
  }

  snapshot(): TimingSnapshot {
    return {
      totalMs: this.now() - this.startedAt,
      entries: this.entries.map((entry) => ({ ...entry }))
    }
  }
}

function milliseconds(value: number): string {
  return `${value.toFixed(1)} ms`
}

export function formatTimingReport(snapshot: TimingSnapshot): string {
  const lines = snapshot.entries.map((entry) => {
    const at = `+${milliseconds(entry.startMs)}`
    return entry.durationMs === undefined
      ? `- ${entry.name}: ${at}`
      : `- ${entry.name}: ${milliseconds(entry.durationMs)} (${at})`
  })
  return `**Debug timing**\n${lines.join('\n')}\n- total to timing report: ${milliseconds(snapshot.totalMs)}`
}
