import type { AutocompleteInteraction, Collection } from 'discord.js'
import type { Subcommand } from './types.js'
import { parseFlags } from './flags.js'
import {
  AGENT_COMMAND_NAME,
  isAgentMcpRuntimeInitializing,
  loadAgentSessionNames
} from './agent/index.js'
import { loadModelsResponse } from './model-catalog.js'

export async function handleCommandAutocomplete(
  interaction: AutocompleteInteraction,
  subcommands: Collection<string, Subcommand>
): Promise<void> {
  if (interaction.commandName === AGENT_COMMAND_NAME) {
    if (isAgentMcpRuntimeInitializing()) {
      await interaction.respond([])
      return
    }
    const focused = interaction.options.getFocused(true)
    const query = String(focused.value).toLowerCase()
    if (focused.name === 'session') {
      await interaction.respond(
        loadAgentSessionNames()
          .filter((session) => session.toLowerCase().includes(query))
          .slice(0, 25)
          .map((session) => ({ name: session, value: session }))
      )
      return
    }
    if (focused.name !== 'model') return
    try {
      const { models } = await loadModelsResponse()
      await interaction.respond(
        models
          .filter((model) => model.length <= 100 && model.toLowerCase().includes(query))
          .slice(0, 25)
          .map((model) => ({ name: model, value: model }))
      )
    } catch (error) {
      console.error('could not autocomplete models', error)
      await interaction.respond([])
    }
    return
  }
  if (interaction.commandName !== 'c') return
  const focused = interaction.options.getFocused()
  const { bare, flags: parsedFlags } = parseFlags(focused)
  const flagsSuffix = [...parsedFlags.entries()]
    .map(([k, v]) => (v === true ? `--${k}` : `--${k} ${v}`))
    .join(' ')
  const withFlags = (val: string) => (flagsSuffix ? `${val} ${flagsSuffix}` : val)
  const parts = bare.split(/\s+/)
  const subName = parts[0].toLowerCase()
  const restArgs = parts.slice(1).join(' ')
  const inArgs = focused.includes(' ')
  const sub = subcommands.get(subName)
  const flagMatch = focused.match(/--(\w*)$/)
  if (flagMatch && inArgs) {
    const prefix = flagMatch[1].toLowerCase()
    const allFlagDefs = { pub: { description: 'public', alias: 'p' }, ...sub?.flags }
    const base = focused.slice(0, focused.lastIndexOf('--'))
    await interaction.respond(
      Object.entries(allFlagDefs)
        .filter(([k, v]) => k.startsWith(prefix) || v.alias?.startsWith(prefix))
        .slice(0, 25)
        .map(([k, v]) => {
          const val = `${base}--${k}`
          return { name: val.trim() + (v.alias ? ` [-${v.alias}]` : ''), value: val }
        })
    )
    return
  }
  if (inArgs) {
    const base = `${subName} ${restArgs}`.trim()
    const subChoices = sub?.autocomplete ? await sub.autocomplete(restArgs, parsedFlags) : []
    const current = subChoices.length === 0 ? [{ name: base, value: withFlags(base) }] : []
    const cmdFlagChoices = Object.keys(sub?.flags ?? {}).map((key) => {
      const value = `${base} --${key}`
      return { name: value, value }
    })
    await interaction.respond(
      [
        ...current,
        ...subChoices,
        ...cmdFlagChoices,
        { name: `${base} --pub`, value: `${base} --pub` }
      ].slice(0, 25)
    )
    return
  }
  function score(sub: Subcommand) {
    if (sub.name === subName) return 3
    if (sub.name.startsWith(subName)) return 2
    if (sub.name.includes(subName) || sub.description.toLowerCase().includes(subName)) return 1
    let qi = 0
    for (const ch of sub.name) if (ch === subName[qi]) qi++
    return qi === subName.length ? 0 : -1
  }
  await interaction.respond(
    [...subcommands.values()]
      .map((sub) => ({ sub, score: score(sub) }))
      .filter(({ score }) => score >= 0 || subName === '')
      .sort((a, b) => b.score - a.score)
      .slice(0, 25)
      .map(({ sub }) => ({ name: withFlags(sub.name), value: withFlags(sub.name) }))
  )
}
