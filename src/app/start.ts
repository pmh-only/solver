import 'dotenv/config'
import { Client, Collection, Events, REST, Routes } from 'discord.js'
import { discordClientOptions } from '../discord/client-options.js'
import { createMessageHandler } from '../discord/gateway/messages.js'
import { registerDeletedMessageTracking } from '../features/messages/deleted.js'
import { createReactionForwardHandler } from '../discord/gateway/reactions.js'
import {
  recordMessageOriginal,
  recordMessageEdit,
  deleteMessageEditHistory,
  deleteMessagesEditHistory,
  showMessageEditHistory
} from '../features/messages/edit-history.js'
import {
  createChatModerationHandler,
  createModerationReactionHandler
} from '../features/moderation/chat.js'
import type { Subcommand } from '../discord/commands/types.js'
import { areApplicationCommandsCurrent } from '../discord/commands/definitions.js'
import {
  replaceApplicationCommands,
  type RegisteredApplicationCommand
} from '../discord/commands/deployment.js'
import { createFeatureRegistry } from './features.js'
import { subcommand as ping } from '../features/utilities/network/ping.js'
import { subcommand as whois } from '../features/utilities/network/whois.js'
import { subcommand as dig } from '../features/utilities/network/dig.js'
import { subcommand as conv } from '../features/utilities/conversion/command.js'
import { subcommand as math } from '../features/utilities/math/command.js'
import { subcommand as set } from '../features/utilities/storage/set.js'
import { subcommand as get } from '../features/utilities/storage/get.js'
import { subcommand as curl } from '../features/utilities/network/curl.js'
import { subcommand as cert } from '../features/utilities/network/cert.js'
import { subcommand as geoip } from '../features/utilities/network/geoip.js'
import { subcommand as run } from '../features/utilities/system/run.js'
import { subcommand as sh } from '../features/utilities/system/sh.js'
import { subcommand as mail } from '../features/utilities/mail.js'
import { subcommand as list } from '../features/utilities/storage/list.js'
import { createPubtabSubcommand } from '../features/utilities/pubtab.js'
import { subcommand as crawl } from '../features/utilities/network/crawl.js'
import { subcommand as coin } from '../features/games/coin.js'
import { subcommand as dice } from '../features/games/dice.js'
import { subcommand as rps } from '../features/games/rps.js'
import { subcommand as slots } from '../features/games/slots.js'
import { subcommand as ttt } from '../features/games/ttt.js'
import { subcommand as hilo } from '../features/games/hilo.js'
import { subcommand as quiz } from '../features/games/quiz/command.js'
import { subcommand as blackjack } from '../features/games/blackjack.js'
import { subcommand as memory } from '../features/games/memory.js'
import { subcommand as usage } from '../features/utilities/system/usage.js'
import { subcommand as chess } from '../features/games/chess.js'
import { subcommand as gohome } from '../features/community/commands/gohome.js'
import { subcommand as lyrics } from '../features/media/lyrics/command.js'
import { subcommand as fileconv } from '../features/media/convert/command.js'
import { subcommand as down } from '../features/media/download/command.js'
import { subcommand as seotda } from '../features/games/seotda/command.js'
import { extraSubcommands } from '../features/utilities/catalog.js'
import { closeWebServer, startWebServer } from '../web/server.js'
import { requireAdminUserIds } from '../shared/security/authorization.js'
import { restoreStoredEnvironment } from '../shared/storage/environment-store.js'
import {
  closeAgentMcpRuntime,
  deleteDynamicAgentFeatureSessions,
  recoverInteractionWithAgent,
  runDynamicAgentFeature
} from '../agent/index.js'
import {
  DynamicDiscordFeatureManager,
  setDynamicDiscordFeatureManager
} from '../features/dynamic/manager.js'
import { safeErrorMessage } from '../shared/runtime/safe-error.js'
import { clearRuntimeIssue, reportRuntimeIssue } from '../shared/runtime/health.js'
import { initializeBotReadyServices } from './bot-ready.js'
import { closeDiscordArchive, setDiscordArchiveClient } from '../features/archive/service.js'

restoreStoredEnvironment()

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
  crawl,
  hilo,
  quiz,
  blackjack,
  memory,
  usage,
  chess,
  gohome,
  lyrics,
  fileconv,
  down,
  seotda,
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

const featureRegistry = createFeatureRegistry(subcommands, recoverInteractionWithAgent)

async function loadRegisteredCommands(rest: REST, clientId: string) {
  return (await rest.get(Routes.applicationCommands(clientId))) as RegisteredApplicationCommand[]
}

async function ensureDeployed(rest: REST, clientId: string) {
  const existing = await loadRegisteredCommands(rest, clientId)

  if (areApplicationCommandsCurrent(existing, featureRegistry.commands)) {
    clearRuntimeIssue('application_command_deployment')
    console.log('skip')
    return
  }

  console.log('deploying...')
  await replaceApplicationCommands(rest, clientId, existing, featureRegistry.commands)
  clearRuntimeIssue('application_command_deployment')
  console.log('done')
}

const token = process.env.DISCORD_TOKEN
const clientId = process.env.DISCORD_CLIENT_ID

if (!token) throw new Error('no token')
if (!clientId) throw new Error('no client id')
const configuredAdminUserIds = requireAdminUserIds()

const rest = new REST().setToken(token)
const dynamicFeatureManager = new DynamicDiscordFeatureManager({
  registry: featureRegistry,
  subcommands,
  run: ({ interaction, feature, input, pub }) =>
    runDynamicAgentFeature(interaction, feature, input, pub),
  cleanup: (feature) => deleteDynamicAgentFeatureSessions(feature.id, configuredAdminUserIds),
  recover: recoverInteractionWithAgent,
  syncCommands: async (registry) => {
    try {
      await replaceApplicationCommands(
        rest,
        clientId,
        await loadRegisteredCommands(rest, clientId),
        registry.commands
      )
      clearRuntimeIssue('application_command_deployment')
    } catch (error) {
      reportRuntimeIssue('application_command_deployment', error)
      throw error
    }
  }
})
dynamicFeatureManager.initialize()
setDynamicDiscordFeatureManager(dynamicFeatureManager)

await ensureDeployed(rest, clientId).catch((error) => {
  reportRuntimeIssue('application_command_deployment', error)
  console.error(`application command deployment failed safely: ${safeErrorMessage(error)}`)
})

const client = new Client(discordClientOptions)
setDiscordArchiveClient(client)

client.once(Events.ClientReady, async (c) => {
  console.log(`ready: ${c.user.tag}`)
  await initializeBotReadyServices(c)
})

client.on(Events.Error, (error) => {
  reportRuntimeIssue('discord_client', error)
  console.error(`Discord client error: ${safeErrorMessage(error)}`)
})

client.on(Events.InteractionCreate, featureRegistry.createHandler(recoverInteractionWithAgent))

const handleMessage = createMessageHandler()
const handleModeration = createChatModerationHandler()
registerDeletedMessageTracking(client)
client.on(Events.MessageCreate, (message) => {
  try {
    recordMessageOriginal(message)
  } catch (error) {
    reportRuntimeIssue('message_edit_history', error)
  }
  void handleModeration(message)
  void handleMessage(message).catch(() => {
    console.error('message handling failed')
  })
})
client.on(Events.MessageUpdate, (previous, message) => {
  void recordMessageEdit(previous, message).catch((error) =>
    reportRuntimeIssue('message_edit_history', error)
  )
  void handleModeration(message)
})
client.on(Events.MessageDelete, (message) => {
  try {
    deleteMessageEditHistory(message)
  } catch (error) {
    reportRuntimeIssue('message_edit_history', error)
  }
})
client.on(Events.MessageBulkDelete, (messages) => {
  try {
    deleteMessagesEditHistory(messages.values())
  } catch (error) {
    reportRuntimeIssue('message_edit_history', error)
  }
})

const handleReactionForward = createReactionForwardHandler()
const syncReactions = (message: Parameters<typeof handleReactionForward>[0]) => {
  void handleReactionForward(message).catch(() => {
    console.error('reaction forwarding failed')
  })
}
const handleModerationReaction = createModerationReactionHandler(handleModeration)
client.on(Events.MessageReactionAdd, (reaction, user) => {
  void showMessageEditHistory(reaction, user).catch((error) =>
    reportRuntimeIssue('message_edit_history', error)
  )
  syncReactions(reaction.message)
  void handleModerationReaction(reaction, user)
})
client.on(Events.MessageReactionRemove, (reaction) => syncReactions(reaction.message))
client.on(Events.MessageReactionRemoveEmoji, (reaction) => syncReactions(reaction.message))
client.on(Events.MessageReactionRemoveAll, (message) => syncReactions(message))

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
  await Promise.all([closeWebServer(webServer), closeAgentMcpRuntime(), closeDiscordArchive()])
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
  await Promise.all([closeWebServer(webServer), closeAgentMcpRuntime(), closeDiscordArchive()])
  throw error
}
