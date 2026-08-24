import { getHolidayNames } from '@hyunbinseo/holidays-kr'
import type { Subcommand } from '../types.js'
import { runRerunnableCommand, summarySection } from '../components.js'
import {
  formatAgentDate,
  getAgentTimeZone,
  getZonedDateParts,
  zonedDateTimeToEpoch
} from '../helpers/timezone.js'

export interface GohomeCountdown {
  date: string
  holidayNames: readonly string[]
  isWeekend: boolean
  targetHour: 18 | 22
  remainingMs: number
  timeZone: string
}

export async function calculateGohomeCountdown(now = new Date()): Promise<GohomeCountdown> {
  const timeZone = getAgentTimeZone()
  const local = getZonedDateParts(now, timeZone)
  const date = formatAgentDate(now, timeZone)
  const holidayNames = (await getHolidayNames(date)) ?? []
  const isWeekend = local.weekday === 0 || local.weekday === 6
  const targetHour = isWeekend || holidayNames.length > 0 ? 18 : 22
  const target = zonedDateTimeToEpoch(
    { year: local.year, month: local.month, day: local.day, hour: targetHour },
    timeZone
  )

  return {
    date,
    holidayNames,
    isWeekend,
    targetHour,
    remainingMs: Math.max(0, target - now.getTime()),
    timeZone
  }
}

export const subcommand: Subcommand = {
  name: 'gohome',
  description: 'count down to go-home time in the agent timezone',
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
      `-# target: ${countdown.targetHour === 18 ? '6:00 PM' : '10:00 PM'} ${countdown.timeZone}`
    ])
  },

  async execute(interaction, args, flags) {
    await runRerunnableCommand(interaction, subcommand, args, flags, () =>
      subcommand.run!(args, flags)
    )
  }
}
