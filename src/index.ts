import 'dotenv/config'
import {
  Client,
  Collection,
  Events,
  GatewayIntentBits,
  REST,
  Routes,
  SlashCommandBuilder
} from 'discord.js'
import type { Subcommand } from './types.js'
import { createHandler } from './handler.js'
import { subcommand as ping } from './commands/ping.js'

const subcommands = new Collection<string, Subcommand>()

for (const sub of [ping]) {
  subcommands.set(sub.name, sub)
}

export const solverCommand = new SlashCommandBuilder()
  .setName('c')
  .setDescription(':)')
  .addStringOption((option) =>
    option.setName('_').setDescription('sub').setRequired(true).setAutocomplete(true)
  )

async function ensureDeployed(clientId: string, token: string) {
  const rest = new REST().setToken(token)
  const existing = (await rest.get(Routes.applicationCommands(clientId))) as { name: string }[]

  if (existing.some((cmd) => cmd.name === 'c')) {
    console.log('skip')
    return
  }

  console.log('deploying...')
  await rest.put(Routes.applicationCommands(clientId), {
    body: [
      {
        ...solverCommand.toJSON(),
        integration_types: [0, 1],
        contexts: [0, 1, 2]
      }
    ]
  })
  console.log('done')
}

const token = process.env.DISCORD_TOKEN
const clientId = process.env.DISCORD_CLIENT_ID

if (!token) throw new Error('no token')
if (!clientId) throw new Error('no client id')

await ensureDeployed(clientId, token)

const client = new Client({
  intents: [GatewayIntentBits.Guilds]
})

client.once(Events.ClientReady, (c) => {
  console.log(`ready: ${c.user.tag}`)
})

client.on(Events.InteractionCreate, createHandler(subcommands))

client.login(token)
