import type { Subcommand } from '../types.js'
import { container } from '../components.js'

export const subcommand: Subcommand = {
  name: 'ping',
  description: 'pong',

  async execute(interaction, args, flags) {
    const latency = Date.now() - interaction.createdTimestamp
    await interaction.reply(container(args, flags, `pong: ${latency}ms`))
  }
}
