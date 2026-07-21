import { afterEach, describe, expect, it, vi } from 'vitest'
import { InteractionResponseType, MessageFlags } from 'discord.js'
import { calculateGohomeCountdown, subcommand as gohome } from '../commands/gohome.js'
import { clearStoredValues } from '../helpers/kv-store.js'
import { commandJSON, dispatch, getCallback, getEdit, makeSubcommands } from './e2e.js'

const subs = makeSubcommands(gohome)

afterEach(() => {
  clearStoredValues()
  vi.useRealTimers()
})

describe('gohome — command', () => {
  it('counts down to 10 PM KST on a regular weekday', async () => {
    const countdown = await calculateGohomeCountdown(new Date('2026-07-21T03:00:00.000Z'))

    expect(countdown).toEqual({
      date: '2026-07-21',
      holidayNames: [],
      isWeekend: false,
      targetHour: 22,
      remainingMs: 36_000_000
    })
  })

  it('counts down to 6 PM KST on weekends', async () => {
    const countdown = await calculateGohomeCountdown(new Date('2026-07-25T03:00:00.000Z'))

    expect(countdown.targetHour).toBe(18)
    expect(countdown.remainingMs).toBe(21_600_000)
    expect(countdown.isWeekend).toBe(true)
  })

  it('counts down to 6 PM KST on Korean substitute holidays', async () => {
    const countdown = await calculateGohomeCountdown(new Date('2026-03-02T03:00:00.000Z'))

    expect(countdown.targetHour).toBe(18)
    expect(countdown.remainingMs).toBe(21_600_000)
    expect(countdown.holidayNames).toEqual(['대체공휴일(3ㆍ1절)'])
  })

  it('uses the KST calendar date near the UTC date boundary', async () => {
    const countdown = await calculateGohomeCountdown(new Date('2026-03-01T16:00:00.000Z'))

    expect(countdown.date).toBe('2026-03-02')
    expect(countdown.targetHour).toBe(18)
    expect(countdown.remainingMs).toBe(61_200_000)
  })

  it('returns zero after the daily go-home time', async () => {
    const countdown = await calculateGohomeCountdown(new Date('2026-03-02T10:00:00.000Z'))

    expect(countdown.remainingMs).toBe(0)
  })

  it('renders the remaining milliseconds and KST target through the command handler', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-07-21T03:00:00.000Z'))

    const calls = await dispatch(commandJSON('gohome'), subs)
    const callback = getCallback(calls) as { type: number; data: { flags: number } }
    const rendered = JSON.stringify(getEdit(calls))

    expect(callback.type).toBe(InteractionResponseType.DeferredChannelMessageWithSource)
    expect(callback.data.flags & MessageFlags.Ephemeral).toBeTruthy()
    expect(rendered).toContain('36000000 ms')
    expect(rendered).toContain('10:00 PM KST')
  })
})
