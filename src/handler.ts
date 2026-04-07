import { Collection, ComponentType, MessageFlags, type Interaction } from 'discord.js'
import type { CommandInteraction, Subcommand } from './types.js'
import {
  buildEditParametersModal,
  container,
  EDIT_PARAMETERS_BUTTON_ID,
  EDIT_PARAMETERS_INPUT_ID,
  EDIT_PARAMETERS_MODAL_ID,
  extractCommandInputFromMessage,
  PUB_BUTTON_ID,
  RETRY_BUTTON_ID
} from './components.js'
import { buildAliasMap, parseFlags, resolveAliases } from './flags.js'
import { evaluateMathString } from './commands/math_core.js'
import { getStoredValue, hasStoredValue } from './helpers/kv-store.js'

function looksLikeMath(input: string): boolean {
  return /[+\-*/%^()]/.test(input)
}

function stripButtons(components: readonly { toJSON(): unknown }[]): unknown[] {
  return components.flatMap((component) => {
    const json = component.toJSON() as {
      type?: number
      components?: Array<{ type?: number }>
    }

    if (json.type !== ComponentType.ActionRow || !Array.isArray(json.components)) {
      return [json]
    }

    const remainingComponents = json.components.filter(
      (child) => child.type !== ComponentType.Button
    )
    if (remainingComponents.length === json.components.length) return [json]
    if (remainingComponents.length === 0) return []

    return [{ ...json, components: remainingComponents }]
  })
}

async function runCommandInput(
  interaction: CommandInteraction,
  subcommands: Collection<string, Subcommand>,
  rawInput: string
) {
  const raw = rawInput.trim()
  const { bare, flags: rawFlags } = parseFlags(raw)
  const subName = bare.split(/\s+/)[0].toLowerCase()
  const sub = subcommands.get(subName)

  const globalAliases = buildAliasMap({ pub: { alias: 'p' } })
  const cmdAliases = sub ? buildAliasMap(sub.flags ?? {}) : new Map<string, string>()
  const aliasMap = new Map([...globalAliases, ...cmdAliases])
  const flags = resolveAliases(rawFlags, aliasMap)

  if (!sub) {
    if (looksLikeMath(bare)) {
      try {
        await interaction.reply(container(bare, flags, evaluateMathString(bare)))
      } catch (error) {
        const message = error instanceof Error ? error.message : 'math err'
        await interaction.reply(container(bare, flags, message))
      }
      return
    }

    if (!bare.includes(' ')) {
      const value = hasStoredValue(bare) ? `${bare}=${getStoredValue(bare)}` : `no ${bare}`
      await interaction.reply(container(bare, flags, value))
      return
    }

    await interaction.reply(container(bare, flags, 'no cmd'))
    return
  }

  try {
    await sub.execute(interaction, bare, flags)
  } catch (error) {
    console.error(error)
    if (interaction.replied || interaction.deferred) {
      await interaction.followUp(container(bare, flags, 'err'))
    } else {
      await interaction.reply(container(bare, flags, 'err'))
    }
  }
}

export function createHandler(subcommands: Collection<string, Subcommand>) {
  return async (interaction: Interaction): Promise<void> => {
    if (interaction.isButton()) {
      if (interaction.customId === PUB_BUTTON_ID) {
        const components = stripButtons(interaction.message.components)
        await interaction.reply({
          components: components as never,
          flags: [MessageFlags.IsComponentsV2]
        })
        return
      }

      if (interaction.customId === RETRY_BUTTON_ID) {
        const commandInput = extractCommandInputFromMessage(interaction)
        if (!commandInput) {
          await interaction.reply(container('retry', new Map(), 'no cmd'))
          return
        }

        await runCommandInput(interaction, subcommands, commandInput)
        return
      }

      if (interaction.customId === EDIT_PARAMETERS_BUTTON_ID) {
        const commandInput = extractCommandInputFromMessage(interaction)
        if (!commandInput) {
          await interaction.reply(container('edit', new Map(), 'no cmd'))
          return
        }

        await interaction.showModal(buildEditParametersModal(commandInput))
        return
      }
    }

    if (interaction.isModalSubmit() && interaction.customId === EDIT_PARAMETERS_MODAL_ID) {
      const commandInput = interaction.fields.getTextInputValue(EDIT_PARAMETERS_INPUT_ID)
      await runCommandInput(interaction, subcommands, commandInput)
      return
    }

    if (interaction.isAutocomplete()) {
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

      const flagMatch = focused.match(/--(\w*)$/)
      if (flagMatch && inArgs) {
        const prefix = flagMatch[1].toLowerCase()
        const sub = subcommands.get(subName)
        const globalFlagDefs: Record<string, { description: string; alias?: string }> = {
          pub: { description: 'public', alias: 'p' }
        }
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

      if (inArgs) {
        const sub = subcommands.get(subName)
        const base = `${subName} ${restArgs}`.trim()

        const subChoices = sub?.autocomplete ? await sub.autocomplete(restArgs, parsedFlags) : []
        const current = subChoices.length === 0 ? [{ name: base, value: withFlags(base) }] : []

        const globalFlagChoices = [{ name: `${base} --pub`, value: `${base} --pub` }]
        const cmdFlagChoices = Object.entries(sub?.flags ?? {}).map(([k]) => {
          const v = `${base} --${k}`
          return { name: v, value: v }
        })

        await interaction.respond(
          [...current, ...subChoices, ...cmdFlagChoices, ...globalFlagChoices].slice(0, 25)
        )
        return
      }

      function score(sub: { name: string; description: string }) {
        const q = subName
        if (sub.name === q) return 3
        if (sub.name.startsWith(q)) return 2
        if (sub.name.includes(q) || sub.description.toLowerCase().includes(q)) return 1
        let qi = 0
        for (const ch of sub.name) {
          if (ch === q[qi]) qi++
        }
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

    await runCommandInput(interaction, subcommands, interaction.options.getString('_', true))
  }
}
