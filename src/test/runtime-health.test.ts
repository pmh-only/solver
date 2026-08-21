import { afterEach, describe, expect, it } from 'vitest'
import {
  clearRuntimeIssue,
  clearRuntimeIssuesForTests,
  reportRuntimeIssue,
  runtimeIssueSummary
} from '../runtime-health.js'

afterEach(() => clearRuntimeIssuesForTests())

describe('runtime health', () => {
  it('retains safe failures for the next agent run and clears repaired sources', () => {
    reportRuntimeIssue(
      'deployment',
      new Error('failed https://discord.example/webhooks/123/secret-token?key=secret')
    )

    expect(runtimeIssueSummary()).toContain('deployment at ')
    expect(runtimeIssueSummary()).toContain('/webhooks/123/[redacted]')
    expect(runtimeIssueSummary()).not.toContain('secret-token')

    clearRuntimeIssue('deployment')
    expect(runtimeIssueSummary()).toBe('')
  })
})
