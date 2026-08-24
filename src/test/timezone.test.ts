import { describe, expect, it } from 'vitest'
import {
  formatAgentDateTime,
  getAgentTimeZone,
  getZonedDateParts,
  zonedDateTimeToEpoch
} from '../helpers/timezone.js'

describe('agent timezone', () => {
  it('reads and validates AGENT_TZ', () => {
    process.env.AGENT_TZ = 'America/New_York'

    expect(getAgentTimeZone()).toBe('America/New_York')
    expect(formatAgentDateTime(new Date('2026-07-21T16:00:00.123Z'))).toBe(
      '2026-07-21T12:00:00.123-04:00 [America/New_York]'
    )
  })

  it('falls back safely for missing or invalid values', () => {
    const hostTimeZone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'

    delete process.env.AGENT_TZ
    expect(getAgentTimeZone()).toBe(hostTimeZone)

    process.env.AGENT_TZ = 'not/a-timezone'
    expect(getAgentTimeZone()).toBe(hostTimeZone)
  })

  it('converts local calendar times across daylight-saving offsets', () => {
    const winter = zonedDateTimeToEpoch(
      { year: 2026, month: 1, day: 15, hour: 22 },
      'America/New_York'
    )
    const summer = zonedDateTimeToEpoch(
      { year: 2026, month: 7, day: 15, hour: 22 },
      'America/New_York'
    )

    expect(new Date(winter).toISOString()).toBe('2026-01-16T03:00:00.000Z')
    expect(new Date(summer).toISOString()).toBe('2026-07-16T02:00:00.000Z')
    expect(getZonedDateParts(new Date(summer), 'America/New_York')).toMatchObject({
      year: 2026,
      month: 7,
      day: 15,
      hour: 22
    })
  })
})
