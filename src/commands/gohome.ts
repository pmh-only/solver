import { getHolidayNames } from '@hyunbinseo/holidays-kr'
import type { Subcommand } from '../types.js'
import { runRerunnableCommand, summarySection } from '../components.js'

const KST_OFFSET_MS = 9 * 60 * 60 * 1000

export interface GohomeCountdown {
  date: string
  holidayNames: readonly string[]
  isWeekend: boolean
  targetHour: 18 | 22
  remainingMs: number
}

function pad(value: number): string {
  return String(value).padStart(2, '0')
}

export async function calculateGohomeCountdown(now = new Date()): Promise<GohomeCountdown> {
  const kst = new Date(now.getTime() + KST_OFFSET_MS)
  const year = kst.getUTCFullYear()
  const month = kst.getUTCMonth()
  const day = kst.getUTCDate()
  const date = `${year}-${pad(month + 1)}-${pad(day)}`
  const holidayNames = (await getHolidayNames(date)) ?? []
  const weekday = kst.getUTCDay()
  const isWeekend = weekday === 0 || weekday === 6
  const targetHour = isWeekend || holidayNames.length > 0 ? 18 : 22
  const target = Date.UTC(year, month, day, targetHour - 9)

  return {
    date,
    holidayNames,
    isWeekend,
    targetHour,
    remainingMs: Math.max(0, target - now.getTime())
  }
}

export const subcommand: Subcommand = {
  name: 'gohome',
  description: 'count down to go-home time in KST',
  usage: 'gohome [--pub]',
  examples: ['gohome'],

  async run() {
    const countdown = await calculateGohomeCountdown()
    const dayType = countdown.holidayNames.length
      ? countdown.holidayNames.join(', ')
      : countdown.isWeekend
        ? 'weekend'
        : 'regular weekday'

    return summarySection('Gohome', [
      `${countdown.remainingMs} ms`,
      `-# ${countdown.date} (${dayType})`,
      `-# target: ${countdown.targetHour === 18 ? '6:00 PM' : '10:00 PM'} KST`
    ])
  },

  async execute(interaction, args, flags) {
    await runRerunnableCommand(interaction, subcommand, args, flags, () =>
      subcommand.run!(args, flags)
    )
  }
}
