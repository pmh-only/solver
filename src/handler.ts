import {
  AttachmentBuilder,
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
  errorContainer,
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
  PUBTAB_BUTTON_ID,
  RETRY_BUTTON_ID,
  scheduleEphemeralMessageDelete,
  scheduleEphemeralReplyDelete
} from './components.js'
import { buildAliasMap, markPubtabContext, parseFlags, resolveAliases } from './flags.js'
import { evaluateMathString } from './commands/math_core.js'
import { getStoredValue, hasStoredValue, isInternalStoredKey } from './helpers/kv-store.js'
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
  AGENT_COMMAND_NAME,
  handleAgentCommand,
  handleGptActionComponent,
  handleGptEffortSelect,
  handleGptModelSelect,
  handleGptModalSubmit,
  handleGptVerbositySelect,
  isGptActionComponentId,
  isGptModalId,
  loadAgentSessionNames
} from './agent/index.js'
import { loadModelsResponse } from './model-catalog.js'
import { handleCoinButton, isCoinButtonId } from './commands/coin.js'
import { handleRpsButton, isRpsButtonId } from './commands/rps.js'
import { handleTttMoveButton, isTttMoveButtonId } from './commands/ttt.js'
import { handlePollButton, isPollButtonId } from './commands/more.js'
import { handleHiloGuessButton, isHiloButtonId } from './commands/hilo.js'
import { handleQuizAnswerButton, isQuizAnswerButtonId } from './commands/quiz.js'
import { handleDiceButton, isDiceButtonId } from './commands/dice.js'
import { handleSlotsSpinButton, isSlotsSpinButtonId } from './commands/slots.js'
import { handleBlackjackButton, isBlackjackButtonId } from './commands/blackjack.js'
import { handleMemoryButton, isMemoryButtonId } from './commands/memory.js'
import {
  handleChessButton,
  handleChessSelect,
  isChessButtonId,
  isChessSelectId
} from './commands/chess.js'
import { isAdminUser } from './authorization.js'

function looksLikeMath(input: string): boolean {
  return /[+\-*/%^()]/.test(input)
}

function stripInteractiveRows(components: readonly { toJSON(): unknown }[]): unknown[] {
  return components.flatMap((component) => {
    const json = component.toJSON() as { type?: number }
    return json.type === ComponentType.ActionRow ? [] : [json]
  })
}

async function publishedPayload(interaction: ButtonInteraction) {
  const files = await Promise.all(
    [...interaction.message.attachments.values()].map(async (attachment) => {
      if (!attachment.name) throw new Error('attachment has no name')
      const response = await fetch(attachment.url, { signal: AbortSignal.timeout(5_000) })
      if (!response.ok) throw new Error(`attachment download failed: ${response.status}`)
      return new AttachmentBuilder(Buffer.from(await response.arrayBuffer()), {
        name: attachment.name,
        description: attachment.description ?? undefined
      })
    })
  )

  return {
    components: stripInteractiveRows(interaction.message.components),
    files
  }
}

function hasComponentsV2Payload(components: readonly { toJSON(): unknown }[]) {
  return components.some((component) => {
    const json = component.toJSON() as { type?: number }
    return json.type !== ComponentType.ActionRow
  })
}

function hasPublicSourceMessage(interaction: Interaction): boolean {
  if (interaction.isMessageComponent()) {
    return !interaction.message.flags.has(MessageFlags.Ephemeral)
  }
  if (interaction.isModalSubmit() && 'message' in interaction && interaction.message) {
    return !interaction.message.flags.has(MessageFlags.Ephemeral)
  }
  return false
}

function isPubtabInteraction(
  interaction: Interaction,
  subcommands: Collection<string, Subcommand>
): boolean {
  if (interaction.isChatInputCommand() && interaction.commandName === 'c') {
    return (
      resolveCommandInput(interaction.options.getString('_', true), subcommands).subName ===
      'pubtab'
    )
  }
  if (interaction.isButton() && interaction.customId === PUBTAB_BUTTON_ID) return true
  if (
    (interaction.isButton() && matchesInteractiveId(interaction.customId, COMMAND_RUN_BUTTON_ID)) ||
    (interaction.isModalSubmit() && interaction.customId.startsWith(`${COMMAND_RUN_MODAL_ID}:`))
  ) {
    try {
      const template = loadConstrainedCommandTemplate(interaction.customId)
      return Boolean(template && subcommands.get(template.command)?.pubtab)
    } catch {
      return false
    }
  }
  return false
}

function isInteractionAllowed(
  interaction: Interaction,
  subcommands: Collection<string, Subcommand>
): boolean {
  return (
    isAdminUser(interaction.user.id) ||
    hasPublicSourceMessage(interaction) ||
    isPubtabInteraction(interaction, subcommands)
  )
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
  rawInput: string,
  fromPubtab = false
) {
  const { bare, flags, sub } = resolveCommandInput(rawInput, subcommands)
  if (fromPubtab) markPubtabContext(flags)

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
      const storedValue =
        !isInternalStoredKey(bare) && hasStoredValue(bare) ? getStoredValue(bare) : undefined
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
    const message = error instanceof Error ? error.message : String(error)
    const reply = errorContainer(bare, flags, message)
    if (interaction.deferred) {
      const message = (await interaction.editReply({
        components: reply.components,
        files: reply.files,
        attachments: [],
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
      if (!isInteractionAllowed(interaction, subcommands)) {
        if (interaction.isAutocomplete()) await interaction.respond([])
        return
      }

      if (interaction.isMessageComponent() && isGptActionComponentId(interaction.customId)) {
        await handleGptActionComponent(interaction)
        return
      }

      if (interaction.isModalSubmit() && isGptModalId(interaction.customId)) {
        await handleGptModalSubmit(interaction)
        return
      }

      if (interaction.isButton()) {
        if (interaction.customId === PUBTAB_BUTTON_ID) {
          const pubtab = subcommands.get('pubtab')
          if (!pubtab) {
            await interaction.reply(container('pubtab', new Map(), 'no cmd'))
            return
          }

          await pubtab.execute(interaction, 'pubtab', new Map())
          return
        }

        if (isRpsButtonId(interaction.customId)) {
          await handleRpsButton(interaction)
          return
        }

        if (isHiloButtonId(interaction.customId)) {
          await handleHiloGuessButton(interaction)
          return
        }

        if (isCoinButtonId(interaction.customId)) {
          await handleCoinButton(interaction)
          return
        }

        if (isDiceButtonId(interaction.customId)) {
          await handleDiceButton(interaction)
          return
        }

        if (isSlotsSpinButtonId(interaction.customId)) {
          await handleSlotsSpinButton(interaction)
          return
        }

        if (isBlackjackButtonId(interaction.customId)) {
          await handleBlackjackButton(interaction)
          return
        }

        if (isMemoryButtonId(interaction.customId)) {
          await handleMemoryButton(interaction)
          return
        }

        if (isChessButtonId(interaction.customId)) {
          await handleChessButton(interaction)
          return
        }

        if (isQuizAnswerButtonId(interaction.customId)) {
          await handleQuizAnswerButton(interaction)
          return
        }

        if (isTttMoveButtonId(interaction.customId)) {
          await handleTttMoveButton(interaction)
          return
        }

        if (isPollButtonId(interaction.customId)) {
          await handlePollButton(interaction)
          return
        }

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
          await interaction.deferReply()
          try {
            const payload = await publishedPayload(interaction)
            await interaction.editReply({
              components: payload.components as never,
              files: payload.files,
              attachments: [],
              flags: MessageFlags.IsComponentsV2
            })
          } catch {
            await sendCommandReply(
              interaction,
              container('pub', new Map([['pub', true]]), 'could not copy attachment')
            )
          }
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
        if (isChessSelectId(interaction.customId)) {
          await handleChessSelect(interaction)
          return
        }

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
            await sendCommandReply(interaction, container('preset', new Map(), 'no cmd'))
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
            await sendCommandReply(interaction, container('help', new Map(), 'no cmd'))
            return
          }

          const { bare, flags, sub } = resolveCommandInput(commandInput, subcommands)
          if (!sub) {
            await sendCommandReply(interaction, container(bare || 'help', flags, 'no cmd'))
            return
          }

          const view = interaction.values[0]
          if (view === 'usage' || view === 'examples' || view === 'flags') {
            await sendCommandReply(interaction, commandReferenceReply(sub, bare, flags, view))
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
        await runCommandInput(interaction, subcommands, commandInput, true)
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
        if (interaction.commandName === AGENT_COMMAND_NAME) {
          const focused = interaction.options.getFocused(true)
          const query = String(focused.value).toLowerCase()
          if (focused.name === 'session') {
            await interaction.respond(
              loadAgentSessionNames(interaction.user.id)
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
      if (interaction.commandName === AGENT_COMMAND_NAME) {
        await handleAgentCommand(interaction)
        return
      }
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

      if (interaction.isChatInputCommand() && interaction.commandName === AGENT_COMMAND_NAME) {
        const message = error instanceof Error ? error.message : String(error)
        const reply = { content: `error: ${message}`, embeds: [], components: [], attachments: [] }
        if (interaction.deferred) await interaction.editReply(reply)
        else if (interaction.replied) await interaction.followUp(reply)
        else await interaction.reply(reply)
        return
      }

      const reply = errorContainer('err', new Map(), 'err')

      if ('deferred' in interaction && interaction.deferred) {
        const message = (await interaction.editReply({
          components: reply.components,
          files: reply.files,
          attachments: [],
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
