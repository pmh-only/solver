import { describe, expect, it } from 'vitest'
import { safeErrorMessage } from '../safe-error.js'

describe('safe error messages', () => {
  it('redacts credentials, authorization values, webhook tokens, and URL queries', () => {
    const safe = safeErrorMessage(
      new Error(
        'Bearer bearer-secret token=plain-secret https://user:pass@example.com/webhooks/123/webhook-secret?api_key=query-secret'
      )
    )

    expect(safe).toContain('Bearer [redacted]')
    expect(safe).toContain('token=[redacted]')
    expect(safe).toContain('/webhooks/123/[redacted]')
    expect(safe).not.toContain('bearer-secret')
    expect(safe).not.toContain('plain-secret')
    expect(safe).not.toContain('webhook-secret')
    expect(safe).not.toContain('query-secret')
    expect(safe).not.toContain('user:pass')
  })

  it('bounds untrusted error text', () => {
    expect(safeErrorMessage(new Error('x'.repeat(10_000)), 100)).toHaveLength(100)
  })
})
