import type {
  ButtonInteraction,
  Interaction,
  ModalSubmitInteraction,
  StringSelectMenuInteraction
} from 'discord.js'
import { matchesInteractiveId } from '../ui/components.js'
import {
  GPT_EFFORT_SELECT_ID,
  GPT_MODEL_SELECT_ID,
  GPT_VERBOSITY_SELECT_ID,
  handleGptActionComponent,
  handleGptEffortSelect,
  handleGptModelSelect,
  handleGptModalSubmit,
  handleGptVerbositySelect,
  isGptActionComponentId,
  isGptModalId
} from '../../agent/index.js'
import { handleCoinButton, isCoinButtonId } from '../../features/games/coin.js'
import { handleRpsButton, isRpsButtonId } from '../../features/games/rps.js'
import { handleTttMoveButton, isTttMoveButtonId } from '../../features/games/ttt.js'
import { handlePollButton, isPollButtonId } from '../../features/utilities/catalog.js'
import { handleHiloGuessButton, isHiloButtonId } from '../../features/games/hilo.js'
import { handleQuizAnswerButton, isQuizAnswerButtonId } from '../../features/games/quiz/command.js'
import { handleDiceButton, isDiceButtonId } from '../../features/games/dice.js'
import { handleSlotsSpinButton, isSlotsSpinButtonId } from '../../features/games/slots.js'
import { handleBlackjackButton, isBlackjackButtonId } from '../../features/games/blackjack.js'
import { handleMemoryButton, isMemoryButtonId } from '../../features/games/memory.js'
import {
  handleChessButton,
  handleChessSelect,
  isChessButtonId,
  isChessSelectId
} from '../../features/games/chess.js'
import {
  handleLyricsControlButton,
  isLyricsControlButtonId
} from '../../features/media/lyrics/command.js'
import { handleFileconvModal, isFileconvModalId } from '../../features/media/convert/command.js'
import { handleSeotdaButton, isSeotdaButtonId } from '../../features/games/seotda/command.js'
import { handleMailSelect, MAIL_MESSAGE_SELECT_ID } from '../../features/utilities/mail.js'
import {
  handleUserImagesCommand,
  USER_IMAGES_COMMAND_NAME
} from '../../features/messages/commands/user-images.js'
import {
  handleMessageInteractionJsonCommand,
  handleUserInteractionJsonCommand,
  MESSAGE_INTERACTION_JSON_COMMAND_NAME,
  USER_INTERACTION_JSON_COMMAND_NAME
} from '../../features/messages/commands/interaction-json.js'
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
} from '../../features/messages/commands/message-render.js'
import {
  handleMessageStoreCommand,
  handleMessageStoreModal,
  MESSAGE_STORE_COMMAND_NAME,
  MESSAGE_STORE_MODAL_ID
} from '../../features/messages/commands/message-store.js'

type ComponentRoute<T> = readonly [
  matches: (id: string) => boolean,
  handle: (interaction: T) => Promise<void>
]
const exact = (id: string) => (value: string) => value === id
const interactive = (id: string) => (value: string) => matchesInteractiveId(value, id)

const buttons: ComponentRoute<ButtonInteraction>[] = [
  [isSeotdaButtonId, handleSeotdaButton],
  [isLyricsControlButtonId, handleLyricsControlButton],
  [isRpsButtonId, handleRpsButton],
  [isHiloButtonId, handleHiloGuessButton],
  [isCoinButtonId, handleCoinButton],
  [isDiceButtonId, handleDiceButton],
  [isSlotsSpinButtonId, handleSlotsSpinButton],
  [isBlackjackButtonId, handleBlackjackButton],
  [isMemoryButtonId, handleMemoryButton],
  [isChessButtonId, handleChessButton],
  [isQuizAnswerButtonId, handleQuizAnswerButton],
  [isTttMoveButtonId, handleTttMoveButton],
  [isPollButtonId, handlePollButton]
]
const selects: ComponentRoute<StringSelectMenuInteraction>[] = [
  [isChessSelectId, handleChessSelect],
  [exact(MESSAGE_COLLECTION_EDIT_SELECT_ID), handleMessageCollectionEditSelect],
  [exact(MAIL_MESSAGE_SELECT_ID), handleMailSelect],
  [interactive(GPT_MODEL_SELECT_ID), handleGptModelSelect],
  [interactive(GPT_EFFORT_SELECT_ID), handleGptEffortSelect],
  [interactive(GPT_VERBOSITY_SELECT_ID), handleGptVerbositySelect]
]
const modals: ComponentRoute<ModalSubmitInteraction>[] = [
  [isGptModalId, handleGptModalSubmit],
  [isFileconvModalId, handleFileconvModal],
  [exact(MESSAGE_STORE_MODAL_ID), handleMessageStoreModal],
  [(id) => id.startsWith(`${MESSAGE_COLLECTION_EDIT_MODAL_ID}:`), handleMessageCollectionEditModal]
]

async function dispatch<T extends { customId: string }>(
  interaction: T,
  routes: ComponentRoute<T>[]
) {
  const route = routes.find(([matches]) => matches(interaction.customId))
  if (!route) return false
  await route[1](interaction)
  return true
}

/** Called only after the central administrator/public-source authorization gate. */
export async function handleFeatureInteraction(interaction: Interaction): Promise<boolean> {
  if (interaction.isMessageComponent() && isGptActionComponentId(interaction.customId)) {
    await handleGptActionComponent(interaction)
    return true
  }
  if (interaction.isButton()) return dispatch(interaction, buttons)
  if (interaction.isStringSelectMenu()) return dispatch(interaction, selects)
  if (interaction.isModalSubmit()) return dispatch(interaction, modals)
  if (interaction.isUserContextMenuCommand()) {
    const handlers: Record<string, typeof handleUserImagesCommand> = {
      [USER_IMAGES_COMMAND_NAME]: handleUserImagesCommand,
      [USER_INTERACTION_JSON_COMMAND_NAME]: handleUserInteractionJsonCommand
    }
    await handlers[interaction.commandName]?.(interaction)
    return true
  }
  if (interaction.isMessageContextMenuCommand()) {
    const handlers: Record<string, typeof handleMessageRenderCommand> = {
      [MESSAGE_RENDER_COMMAND_NAME]: handleMessageRenderCommand,
      [MESSAGE_THREAD_START_COMMAND_NAME]: handleMessageThreadStartCommand,
      [MESSAGE_THREAD_APPEND_COMMAND_NAME]: handleMessageThreadAppendCommand,
      [MESSAGE_STORE_COMMAND_NAME]: handleMessageStoreCommand,
      [MESSAGE_INTERACTION_JSON_COMMAND_NAME]: handleMessageInteractionJsonCommand
    }
    await handlers[interaction.commandName]?.(interaction)
    return true
  }
  return false
}
