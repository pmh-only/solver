import { describe, expect, it } from 'vitest'
import { ApplicationCommandType, InteractionResponseType, MessageFlags } from 'discord.js'
import {
  MESSAGE_INTERACTION_JSON_COMMAND_NAME,
  USER_INTERACTION_JSON_COMMAND_NAME
} from '../commands/interaction-json.js'
import { applicationCommands, areApplicationCommandsCurrent } from '../application-commands.js'
import {
  dispatch,
  getCallback,
  makeSubcommands,
  messageContextJSON,
  userContextJSON
} from './e2e.js'

describe('interaction json commands', () => {
  it('registers user and message context commands', () => {
    expect(
      applicationCommands.some(
        (command) =>
          command.name === USER_INTERACTION_JSON_COMMAND_NAME &&
          command.type === ApplicationCommandType.User
      )
    ).toBe(true)

    expect(
      applicationCommands.some(
        (command) =>
          command.name === MESSAGE_INTERACTION_JSON_COMMAND_NAME &&
          command.type === ApplicationCommandType.Message
      )
    ).toBe(true)
  })

  it('redeploys when stale application commands need to be removed', () => {
    const current = applicationCommands.map((command) => ({
      ...command,
      type: command.type ?? ApplicationCommandType.ChatInput
    }))

    expect(areApplicationCommandsCurrent(current)).toBe(true)
    expect(
      areApplicationCommandsCurrent([
        ...current,
        { name: 'obsolete', type: ApplicationCommandType.ChatInput }
      ])
    ).toBe(false)
  })

  it('redeploys legacy /a and /c command formats', () => {
    const current = applicationCommands.map((command) => ({
      ...command,
      type: command.type ?? ApplicationCommandType.ChatInput
    }))
    const legacyAgent = current.map((command) =>
      command.name === 'a' && 'options' in command
        ? { ...command, options: command.options?.slice(0, 1) }
        : command
    )
    const legacySolver = current.map((command) =>
      command.name === 'c' ? { ...command, options: [] } : command
    )

    expect(areApplicationCommandsCurrent(legacyAgent)).toBe(false)
    expect(areApplicationCommandsCurrent(legacySolver)).toBe(false)
  })

  it('renders full user interaction json', async () => {
    const calls = await dispatch(
      userContextJSON(USER_INTERACTION_JSON_COMMAND_NAME),
      makeSubcommands()
    )
    const body = getCallback(calls) as {
      type: number
      data: { flags: number; components: unknown[] }
    }
    const text = JSON.stringify(body.data.components)

    expect(body.type).toBe(InteractionResponseType.ChannelMessageWithSource)
    expect(body.data.flags & MessageFlags.Ephemeral).toBeTruthy()
    expect(text).toContain('Interaction JSON for Target User')
    expect(text).toContain('targetId')
    expect(text).toContain('555555555555555555')
    expect(text).toContain('commandName')
    expect(text).toContain('User Interaction JSON')
    expect(text).toContain('globalName')
    expect(text).toContain('Target User')
  })

  it('renders full message interaction json', async () => {
    const calls = await dispatch(
      messageContextJSON(MESSAGE_INTERACTION_JSON_COMMAND_NAME),
      makeSubcommands()
    )
    const body = getCallback(calls) as {
      type: number
      data: { flags: number; components: unknown[] }
    }
    const text = JSON.stringify(body.data.components)

    expect(body.type).toBe(InteractionResponseType.ChannelMessageWithSource)
    expect(body.data.flags & MessageFlags.Ephemeral).toBeTruthy()
    expect(text).toContain('Interaction JSON for message 444444444444444444')
    expect(text).toContain('targetId')
    expect(text).toContain('444444444444444444')
    expect(text).toContain('commandName')
    expect(text).toContain('Message Interaction JSON')
    expect(text).toContain('content')
    expect(text).toContain('hello from target message')
  })
})
