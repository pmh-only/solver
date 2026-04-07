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
import { subcommand as whois } from './commands/whois.js'
import { subcommand as dig } from './commands/dig.js'
import { subcommand as conv } from './commands/conv.js'
import { subcommand as math } from './commands/math.js'
import { subcommand as set } from './commands/set.js'
import { subcommand as get } from './commands/get.js'
import { subcommand as curl } from './commands/curl.js'
import { subcommand as cert } from './commands/cert.js'
import { subcommand as geoip } from './commands/geoip.js'
import { subcommand as run } from './commands/run.js'
import { subcommand as sh } from './commands/sh.js'

const subcommands = new Collection<string, Subcommand>()

for (const sub of [ping, whois, dig, conv, math, set, get, curl, cert, geoip, run, sh]) {
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
