import { randomInt } from 'node:crypto'
import { z } from 'zod'
import type { Subcommand } from '../types.js'
import {
  commandContainer,
  commandReferenceReply,
  runRerunnableCommand,
  sendCommandReply,
  summarySection
} from '../components.js'
import { loadCommunitySettings } from '../community-settings.js'
import { defaultFoods } from './community-foods.js'
import { fetchCommunityBytes } from './community-http.js'
import { formatAgentDateTime } from '../helpers/timezone.js'

const rest = (args: string) => args.replace(/^\S+\s*/, '').trim()
const pizzaSchema = z.object({ defcon_level: z.coerce.number().int().min(1).max(5) })

export function createLeisureCommands(): Subcommand[] {
  const food: Subcommand = {
    name: 'food',
    description: '음식 추천',
    usage: '/food [filter:<이름 또는 태그>]',
    examples: ['/food', '/food filter:한식 혼밥'],
    async execute(interaction, args, flags) {
      const settings = loadCommunitySettings(interaction.guildId ?? interaction.user.id)
      if (settings.disabledCommands.includes('food')) throw new Error('비활성화된 기능입니다.')
      await runRerunnableCommand(interaction, food, args, flags, async () => {
        const terms = rest(args).split(/\s+/).filter(Boolean)
        const choices = (settings.foods ?? defaultFoods).filter((food) =>
          terms.every((term) =>
            [food.name, ...food.tags].some((value) => value.includes(term.replace(/^#/, '')))
          )
        )
        if (!choices.length) throw new Error('조건에 맞는 음식이 없습니다.')
        const choice = choices[randomInt(choices.length)]!
        return summarySection('오늘의 메뉴', [
          choice.name,
          choice.tags.map((tag) => `#${tag}`).join(' ')
        ])
      })
    }
  }
  const pizza: Subcommand = {
    name: 'pizza',
    description: '펜타곤 피자 지수',
    usage: '/pizza',
    examples: ['/pizza'],
    async run() {
      const bytes = await fetchCommunityBytes(
        'https://www.pizzint.watch/api/dashboard-data?nocache=1',
        1024 * 1024
      )
      const data = pizzaSchema.parse(JSON.parse(bytes.toString('utf8')))
      return summarySection('🍕 PIZZA INDEX', [
        `**DEFCON ${data.defcon_level}**`,
        '-# 비공식 피자 지표이며 실제 군사 경보가 아닙니다.',
        '<https://www.pizzint.watch>'
      ])
    },
    async execute(interaction, args, flags) {
      if (
        loadCommunitySettings(interaction.guildId ?? interaction.user.id).disabledCommands.includes(
          'pizza'
        )
      )
        throw new Error('비활성화된 기능입니다.')
      if (rest(args)) {
        await sendCommandReply(
          interaction,
          commandReferenceReply(pizza, args, flags, 'usage', '인수가 필요하지 않습니다.')
        )
        return
      }
      await runRerunnableCommand(interaction, pizza, args, flags, () => pizza.run!(args, flags))
    }
  }
  const now: Subcommand = {
    name: 'now',
    description: '현재 시각',
    usage: '/now',
    examples: ['/now'],
    async execute(interaction, args, flags) {
      if (
        loadCommunitySettings(interaction.guildId ?? interaction.user.id).disabledCommands.includes(
          'now'
        )
      )
        throw new Error('비활성화된 기능입니다.')
      const date = new Date()
      await sendCommandReply(
        interaction,
        commandContainer(
          now,
          args,
          flags,
          summarySection('현재 시각', [
            formatAgentDateTime(date),
            `${date.getTime()} ms`,
            `<t:${Math.floor(date.getTime() / 1000)}:R>`
          ])
        )
      )
    }
  }
  return [food, ...['foods', '점메추', '저메추'].map((name) => ({ ...food, name })), pizza, now]
}

export const leisureCommands = createLeisureCommands()
