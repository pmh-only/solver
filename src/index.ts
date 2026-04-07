import 'dotenv/config'
import {
  Client,
  Collection,
  ComponentType,
  Events,
  GatewayIntentBits,
  MessageFlags,
  REST,
  Routes,
  SlashCommandBuilder
} from 'discord.js'
import type { Subcommand } from './types.js'
import { container, PUB_BUTTON_ID } from './components.js'
import { buildAliasMap, parseFlags, resolveAliases } from './flags.js'
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

client.on(Events.InteractionCreate, async (interaction) => {
  if (interaction.isButton() && interaction.customId === PUB_BUTTON_ID) {
    const components = interaction.message.components
      .filter((c) => !(c.type === ComponentType.ActionRow && c.components.some((b) => 'customId' in b && b.customId === PUB_BUTTON_ID)))
      .map((c) => c.toJSON())
    await interaction.reply({ components, flags: [MessageFlags.IsComponentsV2] })
    return
  }

  if (interaction.isAutocomplete()) {
    if (interaction.commandName !== 'c') return

    const focused = interaction.options.getFocused()
    const { bare, flags: parsedFlags } = parseFlags(focused)
    const flagsSuffix = [...parsedFlags.entries()]
      .map(([k, v]) => (v === true ? `--${k}` : `--${k} ${v}`))
      .join(' ')
    const withFlags = (val: string) => flagsSuffix ? `${val} ${flagsSuffix}` : val

    const parts = bare.split(/\s+/)
    const subName = parts[0].toLowerCase()
    const restArgs = parts.slice(1).join(' ')
    const inArgs = bare.includes(' ') || focused.endsWith(' ')

    // flag completion: user typed "--" anywhere after subcommand
    const flagMatch = focused.match(/--(\w*)$/)
    if (flagMatch && inArgs) {
      const prefix = flagMatch[1].toLowerCase()
      const sub = subcommands.get(subName)
      const globalFlagDefs: Record<string, { description: string; alias?: string }> = { pub: { description: 'publish response publicly', alias: 'p' } }
      const cmdFlagDefs = sub?.flags ?? {}
      const allFlagDefs = { ...globalFlagDefs, ...cmdFlagDefs }
      const base = focused.slice(0, focused.lastIndexOf('--'))
      const suggestions = Object.entries(allFlagDefs)
        .filter(([k, v]) => k.startsWith(prefix) || v.alias?.startsWith(prefix))
        .slice(0, 25)
        .map(([k, v]) => {
          const val = `${base}--${k}`
          return { name: val.trim() + (v.alias ? ` [-${v.alias}]` : ''), value: val }
        })
      await interaction.respond(suggestions)
      return
    }

    // args mode: subcommand identified, delegate then always append flags
    if (inArgs) {
      const sub = subcommands.get(subName)
      const base = `${subName} ${restArgs}`.trim()

      const subChoices = sub?.autocomplete ? await sub.autocomplete(restArgs, parsedFlags) : []
      const current = subChoices.length === 0 ? [{ name: base, value: withFlags(base) }] : []

      const globalFlagChoices = [{ name: `${base} --pub`, value: `${base} --pub` }]
      const cmdFlagChoices = Object.entries(sub?.flags ?? {}).map(([k]) => {
        const v = `${base} --${k}`; return { name: v, value: v }
      })

      await interaction.respond([...current, ...subChoices, ...cmdFlagChoices, ...globalFlagChoices].slice(0, 25))
      return
    }

    // subcommand selection mode
    function score(sub: { name: string; description: string }) {
      const q = subName
      if (sub.name === q) return 3
      if (sub.name.startsWith(q)) return 2
      if (sub.name.includes(q) || sub.description.toLowerCase().includes(q)) return 1
      // character subsequence fallback
      let qi = 0
      for (const ch of sub.name) { if (ch === q[qi]) qi++ }
      return qi === q.length ? 0 : -1
    }

    const matches = [...subcommands.values()]
      .map((sub) => ({ sub, s: score(sub) }))
      .filter(({ s }) => s >= 0 || subName === '')
      .sort((a, b) => b.s - a.s)
      .slice(0, 25)
      .map(({ sub }) => ({ name: withFlags(sub.name), value: withFlags(sub.name) }))

    await interaction.respond(matches)
    return
  }

  if (!interaction.isChatInputCommand()) return
  if (interaction.commandName !== 'c') return

  const raw = interaction.options.getString('_', true).trim()
  const { bare, flags: rawFlags } = parseFlags(raw)
  const subName = bare.split(/\s+/)[0].toLowerCase()
  const sub = subcommands.get(subName)

  const globalAliases = buildAliasMap({ pub: { alias: 'p' } })
  const cmdAliases = sub ? buildAliasMap(sub.flags ?? {}) : new Map<string, string>()
  const aliasMap = new Map([...globalAliases, ...cmdAliases])
  const flags = resolveAliases(rawFlags, aliasMap)

  if (!sub) {
    await interaction.reply(container(bare, flags, `unknown: ${subName}`))
    return
  }

  try {
    await sub.execute(interaction, bare, flags)
  } catch (error) {
    console.error(error)
    if (interaction.replied || interaction.deferred) {
      await interaction.followUp(container(bare, flags, 'error'))
    } else {
      await interaction.reply(container(bare, flags, 'error'))
    }
  }
})

client.login(token)
