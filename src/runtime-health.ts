import { safeErrorMessage } from './safe-error.js'

const runtimeIssues = new Map<string, { detail: string; occurredAt: string }>()

export function reportRuntimeIssue(source: string, error: unknown): void {
  runtimeIssues.set(source, {
    detail: safeErrorMessage(error),
    occurredAt: new Date().toISOString()
  })
}

export function clearRuntimeIssue(source: string): void {
  runtimeIssues.delete(source)
}

export function runtimeIssueSummary(): string {
  return [...runtimeIssues]
    .map(([source, issue]) => `${source} at ${issue.occurredAt}: ${issue.detail}`)
    .join('; ')
    .slice(0, 8_000)
}

export function clearRuntimeIssuesForTests(): void {
  runtimeIssues.clear()
}
