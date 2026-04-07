import type { Subcommand } from '../types.js'
import { container } from '../components.js'
import { getStoredValue, hasStoredValue } from '../helpers/kv-store.js'

function parseGetArgs(args: string): string {
  return args.replace(/^\S+\s*/, '').trim()
}

export const subcommand: Subcommand = {
  name: 'get',
  description: 'get var',

  async execute(interaction, args, flags) {
    const key = parseGetArgs(args)

    if (!key) {
      await interaction.reply(container(args, flags, 'no key'))
      return
    }

    if (!hasStoredValue(key)) {
      await interaction.reply(container(args, flags, `no ${key}`))
      return
    }

    const value = getStoredValue(key) as string
    await interaction.reply(container(args, flags, `${key}=${value}`))
  }
}
