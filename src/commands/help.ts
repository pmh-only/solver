import type { Subcommand } from '../types.js'
import {
  commandContainer,
  commandReferenceReply,
  sendCommandReply,
  summarySection
} from '../components.js'

export function createHelpSubcommand(commands: readonly Subcommand[]): Subcommand {
  const help: Subcommand = {
    name: 'help',
    description: '명령 목록 및 사용법',
    usage: 'help [명령] [--pub]',
    examples: ['help', 'help kickvote'],
    async autocomplete(input) {
      return commands
        .filter((command) => command.name.startsWith(input))
        .slice(0, 25)
        .map((command) => ({ name: command.name, value: command.name }))
    },
    async execute(interaction, args, flags) {
      const name = args.replace(/^\S+\s*/, '').trim()
      if (name) {
        const command = commands.find((command) => command.name === name)
        await sendCommandReply(
          interaction,
          commandReferenceReply(
            command ?? help,
            args,
            flags,
            'usage',
            command ? undefined : '명령을 찾을 수 없습니다.'
          )
        )
        return
      }
      await sendCommandReply(
        interaction,
        commandContainer(
          help,
          args,
          flags,
          summarySection('명령 목록', [
            commands
              .map((command) => `\`${command.name}\``)
              .join(' · ')
              .slice(0, 3000),
            '`/c help <명령>`으로 사용법을 확인하세요. 서버 기능과 음식 목록은 `/a`에서 설정할 수 있습니다.'
          ])
        )
      )
    }
  }
  return help
}
