import {
  Collection,
  ComponentType,
  MessageFlags,
  type ButtonInteraction,
  type Interaction
} from 'discord.js'
import type { CommandInteraction, Subcommand } from './types.js'
import {
  buildEditParametersModal,
  buildConstrainedCommandInput,
  buildConstrainedCommandModal,
  cancelEphemeralDelete,
  COMMAND_ACTION_SELECT_ID,
  COMMAND_PRESET_SELECT_ID,
  container,
  commandReferenceReply,
  contentPublishButtonRow,
  loadContentPublishValue,
  pinnedMessageComponents,
  sendCommandReply,
  sendPlainTextReply,
  EDIT_PARAMETERS_BUTTON_ID,
  EDIT_PARAMETERS_INPUT_ID,
  EDIT_PARAMETERS_MODAL_ID,
  COMMAND_RUN_BUTTON_ID,
  COMMAND_RUN_INPUT_ID,
  COMMAND_RUN_MODAL_ID,
  extractCommandInputFromMessage,
  hasEphemeralFlag,
  loadConstrainedCommandTemplate,
  matchesInteractiveId,
  PIN_BUTTON_ID,
  PUB_BUTTON_ID,
  PUB_CONTENT_BUTTON_ID,
  RETRY_BUTTON_ID,
  scheduleEphemeralMessageDelete,
  scheduleEphemeralReplyDelete
} from './components.js'
import { buildAliasMap, parseFlags, resolveAliases } from './flags.js'
import { evaluateMathString } from './commands/math_core.js'
import { getStoredValue, hasStoredValue } from './helpers/kv-store.js'
import { handleMailSelect, MAIL_MESSAGE_SELECT_ID } from './commands/mail.js'
import { handleUserImagesCommand, USER_IMAGES_COMMAND_NAME } from './commands/user-images.js'
import {
  handleMessageInteractionJsonCommand,
  handleUserInteractionJsonCommand,
  MESSAGE_INTERACTION_JSON_COMMAND_NAME,
  USER_INTERACTION_JSON_COMMAND_NAME
} from './commands/interaction-json.js'
import {
  handleMessageCollectionEditModal,
  handleMessageCollectionEditSelect,
  handleMessageRenderCommand,
  handleMessageThreadAppendCommand,
  handleMessageThreadStartCommand,
  MESSAGE_COLLECTION_EDIT_MODAL_ID,
  MESSAGE_COLLECTION_EDIT_SELECT_ID,
  MESSAGE_RENDER_COMMAND_NAME,
  MESSAGE_THREAD_APPEND_COMMAND_NAME,
  MESSAGE_THREAD_START_COMMAND_NAME
} from './commands/message-render.js'
import {
  handleMessageStoreCommand,
  handleMessageStoreModal,
  MESSAGE_STORE_COMMAND_NAME,
  MESSAGE_STORE_MODAL_ID
} from './commands/message-store.js'
import {
  GPT_EFFORT_SELECT_ID,
  GPT_MODEL_SELECT_ID,
  GPT_VERBOSITY_SELECT_ID,
  handleGptEffortSelect,
  handleGptModelSelect,
  handleGptVerbositySelect
} from './commands/gpt.js'

function looksLikeMath(input: string): boolean {
  return /[+\-*/%^()]/.test(input)
}

function stripInteractiveRows(components: readonly { toJSON(): unknown }[]): unknown[] {
  return components.flatMap((component) => {
    const json = component.toJSON() as { type?: number }
    return json.type === ComponentType.ActionRow ? [] : [json]
  })
}

function replaceAttachmentUrls(value: unknown, attachments: Map<string, string>): unknown {
  if (typeof value === 'string' && value.startsWith('attachment://')) {
    return attachments.get(value.slice('attachment://'.length)) ?? value
  }

  if (Array.isArray(value)) {
    return value.map((entry) => replaceAttachmentUrls(entry, attachments))
  }

  if (!value || typeof value !== 'object') return value

  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => [key, replaceAttachmentUrls(entry, attachments)])
  )
}

function publishedComponents(interaction: ButtonInteraction): unknown[] {
  const attachments = new Map(
    [...interaction.message.attachments.values()]
      .filter((attachment) => Boolean(attachment.name))
      .map((attachment) => [attachment.name as string, attachment.url])
  )

  return stripInteractiveRows(interaction.message.components).map((component) =>
    replaceAttachmentUrls(component, attachments)
  )
}

function hasComponentsV2Payload(components: readonly { toJSON(): unknown }[]) {
  return components.some((component) => {
    const json = component.toJSON() as { type?: number }
    return json.type !== ComponentType.ActionRow
  })
}

function resolveCommandInput(rawInput: string, subcommands: Collection<string, Subcommand>) {
  const raw = rawInput.trim()
  const { bare, flags: rawFlags } = parseFlags(raw)
  const subName = bare.split(/\s+/)[0].toLowerCase()
  const sub = subcommands.get(subName)

  const globalAliases = buildAliasMap({ pub: { alias: 'p' } })
  const cmdAliases = sub ? buildAliasMap(sub.flags ?? {}) : new Map<string, string>()
  const aliasMap = new Map([...globalAliases, ...cmdAliases])
  const flags = resolveAliases(rawFlags, aliasMap)

  return { raw, bare, flags, subName, sub }
}

async function runCommandInput(
  interaction: CommandInteraction,
  subcommands: Collection<string, Subcommand>,
  rawInput: string
) {
  const { bare, flags, sub } = resolveCommandInput(rawInput, subcommands)

  if (!sub) {
    if (looksLikeMath(bare)) {
      try {
        await sendCommandReply(interaction, container(bare, flags, evaluateMathString(bare)))
      } catch (error) {
        const message = error instanceof Error ? error.message : 'math err'
        await sendCommandReply(interaction, container(bare, flags, message))
      }
      return
    }

    if (!bare.includes(' ')) {
      const storedValue = hasStoredValue(bare) ? getStoredValue(bare) : undefined
      const replyFlags = flags.has('pub') ? undefined : ([MessageFlags.Ephemeral] as const)

      await sendPlainTextReply(
        interaction,
        storedValue !== undefined
          ? flags.has('pub')
            ? { content: storedValue }
            : {
                content: storedValue,
                components: [contentPublishButtonRow(storedValue)],
                flags: replyFlags
              }
          : { content: `no ${bare}`, flags: replyFlags }
      )
      return
    }

    await sendCommandReply(interaction, container(bare, flags, 'no cmd'))
    return
  }

  try {
    await sub.execute(interaction, bare, flags)
  } catch (error) {
    console.error(error)
    const reply = container(bare, flags, 'err')
    if (interaction.deferred) {
      const message = (await interaction.editReply({
        components: reply.components,
        flags: MessageFlags.IsComponentsV2
      })) as { id?: string }
      if (typeof message.id === 'string') {
        scheduleEphemeralReplyDelete(interaction, message.id, reply.flags)
      }
    } else if (interaction.replied) {
      const message = (await interaction.followUp(reply)) as { id?: string }
      if (typeof message.id === 'string') {
        scheduleEphemeralMessageDelete(interaction.webhook, message.id, reply.flags)
      }
    } else {
      await sendCommandReply(interaction, reply)
    }
  }
}

export function createHandler(subcommands: Collection<string, Subcommand>) {
  return async (interaction: Interaction): Promise<void> => {
    try {
      if (interaction.isButton()) {
        if (interaction.customId === PIN_BUTTON_ID) {
          cancelEphemeralDelete(interaction.message.id)
          const components = pinnedMessageComponents(interaction.message.components) as never
          if (hasComponentsV2Payload(interaction.message.components)) {
            await interaction.update({
              components,
              flags: MessageFlags.IsComponentsV2
            })
          } else {
            await interaction.update({ components })
          }
          return
        }

        if (interaction.customId === PUB_BUTTON_ID) {
          const components = publishedComponents(interaction)
          await interaction.reply({
            components: components as never,
            flags: [MessageFlags.IsComponentsV2]
          })
          return
        }

        if (interaction.customId.startsWith(`${PUB_CONTENT_BUTTON_ID}:`)) {
          const content = loadContentPublishValue(interaction.customId)
          if (content) {
            await interaction.reply({ content })
          } else {
            await interaction.reply(container('pub', new Map(), 'no content'))
          }
          return
        }

        if (matchesInteractiveId(interaction.customId, RETRY_BUTTON_ID)) {
          const commandInput = extractCommandInputFromMessage(interaction)
          if (!commandInput) {
            await interaction.reply(container('retry', new Map(), 'no cmd'))
            return
          }

          await runCommandInput(interaction, subcommands, commandInput)
          return
        }

        if (matchesInteractiveId(interaction.customId, COMMAND_RUN_BUTTON_ID)) {
          const template = loadConstrainedCommandTemplate(interaction.customId)
          if (!template) {
            await interaction.reply(container('pubtab', new Map(), 'no cmd'))
            return
          }

          await interaction.showModal(buildConstrainedCommandModal(interaction.customId, template))
          return
        }

        if (matchesInteractiveId(interaction.customId, EDIT_PARAMETERS_BUTTON_ID)) {
          const commandInput = extractCommandInputFromMessage(interaction)
          if (!commandInput) {
            await interaction.reply(container('edit', new Map(), 'no cmd'))
            return
          }

          await interaction.showModal(buildEditParametersModal(commandInput))
          return
        }
      }

      if (interaction.isStringSelectMenu()) {
        if (interaction.customId === MESSAGE_COLLECTION_EDIT_SELECT_ID) {
          await handleMessageCollectionEditSelect(interaction)
          return
        }

        if (interaction.customId === MAIL_MESSAGE_SELECT_ID) {
          await handleMailSelect(interaction)
          return
        }

        if (interaction.customId === COMMAND_PRESET_SELECT_ID) {
          const preset = interaction.values[0]
          if (!preset) {
            await interaction.update({
              components: container('preset', new Map(), 'no cmd').components,
              flags: MessageFlags.IsComponentsV2
            })
            return
          }

          await interaction.showModal(buildEditParametersModal(preset))
          return
        }

        if (matchesInteractiveId(interaction.customId, GPT_MODEL_SELECT_ID)) {
          await handleGptModelSelect(interaction)
          return
        }

        if (matchesInteractiveId(interaction.customId, GPT_EFFORT_SELECT_ID)) {
          await handleGptEffortSelect(interaction)
          return
        }

        if (matchesInteractiveId(interaction.customId, GPT_VERBOSITY_SELECT_ID)) {
          await handleGptVerbositySelect(interaction)
          return
        }

        if (matchesInteractiveId(interaction.customId, COMMAND_ACTION_SELECT_ID)) {
          const commandInput = extractCommandInputFromMessage(interaction)
          if (!commandInput) {
            await interaction.update({
              components: container('help', new Map(), 'no cmd').components,
              flags: MessageFlags.IsComponentsV2
            })
            return
          }

          const { bare, flags, sub } = resolveCommandInput(commandInput, subcommands)
          if (!sub) {
            await interaction.update({
              components: container(bare || 'help', flags, 'no cmd').components,
              flags: MessageFlags.IsComponentsV2
            })
            return
          }

          const view = interaction.values[0]
          if (view === 'usage' || view === 'examples' || view === 'flags') {
            await interaction.update({
              components: commandReferenceReply(sub, bare, flags, view).components,
              flags: MessageFlags.IsComponentsV2
            })
            return
          }
        }
      }

      if (interaction.isModalSubmit() && interaction.customId === EDIT_PARAMETERS_MODAL_ID) {
        const commandInput = interaction.fields.getTextInputValue(EDIT_PARAMETERS_INPUT_ID)
        await runCommandInput(interaction, subcommands, commandInput)
        return
      }

      if (
        interaction.isModalSubmit() &&
        interaction.customId.startsWith(`${COMMAND_RUN_MODAL_ID}:`)
      ) {
        const template = loadConstrainedCommandTemplate(interaction.customId)
        if (!template) {
          await interaction.reply(container('pubtab', new Map(), 'no cmd'))
          return
        }

        const commandInput = buildConstrainedCommandInput(
          template,
          interaction.fields.getTextInputValue(COMMAND_RUN_INPUT_ID)
        )

        await interaction.deferReply()
        await runCommandInput(interaction, subcommands, commandInput)
        return
      }

      if (interaction.isModalSubmit() && interaction.customId === MESSAGE_STORE_MODAL_ID) {
        await handleMessageStoreModal(interaction)
        return
      }

      if (
        interaction.isModalSubmit() &&
        interaction.customId.startsWith(`${MESSAGE_COLLECTION_EDIT_MODAL_ID}:`)
      ) {
        await handleMessageCollectionEditModal(interaction)
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

      if (interaction.isUserContextMenuCommand()) {
        if (interaction.commandName === USER_IMAGES_COMMAND_NAME) {
          await handleUserImagesCommand(interaction)
          return
        }

        if (interaction.commandName === USER_INTERACTION_JSON_COMMAND_NAME) {
          await handleUserInteractionJsonCommand(interaction)
          return
        }

        return
      }

      if (interaction.isMessageContextMenuCommand()) {
        if (interaction.commandName === MESSAGE_RENDER_COMMAND_NAME) {
          await handleMessageRenderCommand(interaction)
          return
        }

        if (interaction.commandName === MESSAGE_THREAD_START_COMMAND_NAME) {
          await handleMessageThreadStartCommand(interaction)
          return
        }

        if (interaction.commandName === MESSAGE_THREAD_APPEND_COMMAND_NAME) {
          await handleMessageThreadAppendCommand(interaction)
          return
        }

        if (interaction.commandName === MESSAGE_STORE_COMMAND_NAME) {
          await handleMessageStoreCommand(interaction)
          return
        }

        if (interaction.commandName === MESSAGE_INTERACTION_JSON_COMMAND_NAME) {
          await handleMessageInteractionJsonCommand(interaction)
          return
        }

        return
      }

      if (!interaction.isChatInputCommand()) return
      if (interaction.commandName !== 'c') return

      await runCommandInput(interaction, subcommands, interaction.options.getString('_', true))
    } catch (error) {
      console.error(error)

      if (interaction.isAutocomplete()) {
        if (!interaction.responded) {
          await interaction.respond([])
        }
        return
      }

      const reply = container('err', new Map(), 'err')

      if ('deferred' in interaction && interaction.deferred) {
        const message = (await interaction.editReply({
          components: reply.components,
          flags: MessageFlags.IsComponentsV2
        })) as { id?: string }
        if (typeof message.id === 'string') {
          scheduleEphemeralReplyDelete(interaction, message.id, reply.flags)
        }
        return
      }

      if ('replied' in interaction && interaction.replied) {
        if ('followUp' in interaction) {
          const message = (await interaction.followUp(reply)) as { id?: string }
          if (
            hasEphemeralFlag(reply.flags) &&
            typeof message.id === 'string' &&
            'webhook' in interaction
          ) {
            scheduleEphemeralMessageDelete(interaction.webhook, message.id, reply.flags)
          }
        }
        return
      }

      if ('reply' in interaction) {
        await interaction.reply(reply)
        if ('fetchReply' in interaction && hasEphemeralFlag(reply.flags)) {
          const message = (await interaction.fetchReply()) as { id?: string }
          if (typeof message.id === 'string') {
            scheduleEphemeralReplyDelete(interaction, message.id, reply.flags)
          }
        }
      }
    }
  }
}
