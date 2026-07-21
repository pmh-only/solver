import 'dotenv/config'
import { Client, Collection, Events, GatewayIntentBits, REST, Routes } from 'discord.js'
import type { Subcommand } from './types.js'
import { areApplicationCommandsCurrent } from './application-commands.js'
import {
  replaceApplicationCommands,
  type RegisteredApplicationCommand
} from './application-command-deployment.js'
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
import { subcommand as mail } from './commands/mail.js'
import { subcommand as list } from './commands/list.js'
import { createPubtabSubcommand } from './commands/pubtab.js'
import { subcommand as gpt } from './commands/gpt.js'
import { subcommand as crawl } from './commands/crawl.js'
import { subcommand as coin } from './commands/coin.js'
import { subcommand as dice } from './commands/dice.js'
import { subcommand as rps } from './commands/rps.js'
import { subcommand as slots } from './commands/slots.js'
import { subcommand as ttt } from './commands/ttt.js'
import { subcommand as hilo } from './commands/hilo.js'
import { subcommand as quiz } from './commands/quiz.js'
import { subcommand as blackjack } from './commands/blackjack.js'
import { subcommand as memory } from './commands/memory.js'
import { subcommand as usage } from './commands/usage.js'
import { subcommand as chess } from './commands/chess.js'
import { subcommand as gohome } from './commands/gohome.js'
import { extraSubcommands } from './commands/more.js'
import { closeWebServer, startWebServer } from './web-server.js'
import { requireAdminUserIds } from './authorization.js'

const subcommands = new Collection<string, Subcommand>()

const commands = [
  ping,
  whois,
  dig,
  conv,
  math,
  set,
  get,
  list,
  curl,
  cert,
  geoip,
  run,
  sh,
  mail,
  gpt,
  crawl,
  hilo,
  quiz,
  blackjack,
  memory,
  usage,
  chess,
  gohome,
  coin,
  dice,
  rps,
  slots,
  ttt,
  ...extraSubcommands
]

for (const sub of [...commands, createPubtabSubcommand(commands)]) {
  subcommands.set(sub.name, sub)
}

async function ensureDeployed(clientId: string, token: string) {
  const rest = new REST().setToken(token)
  const existing = (await rest.get(
    Routes.applicationCommands(clientId)
  )) as RegisteredApplicationCommand[]

  if (areApplicationCommandsCurrent(existing)) {
    console.log('skip')
    return
  }

  console.log('deploying...')
  await replaceApplicationCommands(rest, clientId, existing)
  console.log('done')
}

const token = process.env.DISCORD_TOKEN
const clientId = process.env.DISCORD_CLIENT_ID

if (!token) throw new Error('no token')
if (!clientId) throw new Error('no client id')
requireAdminUserIds()

await ensureDeployed(clientId, token)

const client = new Client({
  intents: [GatewayIntentBits.Guilds]
})

client.once(Events.ClientReady, (c) => {
  console.log(`ready: ${c.user.tag}`)
})

client.on(Events.InteractionCreate, createHandler(subcommands))

const webServer = await startWebServer()
const address = webServer.address()
console.log(
  `web server: ${typeof address === 'object' && address ? `${address.address}:${address.port}` : String(address)}`
)

let shuttingDown = false
async function shutdown(signal: string) {
  if (shuttingDown) return
  shuttingDown = true
  console.log(`shutdown: ${signal}`)
  client.destroy()
  await closeWebServer(webServer)
}

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    void shutdown(signal)
      .then(() => process.exit(0))
      .catch((error) => {
        console.error(error)
        process.exit(1)
      })
  })
}

try {
  await client.login(token)
} catch (error) {
  await closeWebServer(webServer)
  throw error
}
