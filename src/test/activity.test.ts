import { describe, expect, it } from 'vitest'
import {
  ApplicationCommandType,
  EntryPointCommandHandlerType,
  InteractionResponseType,
  MessageFlags
} from 'discord.js'
import { ACTIVITY_LAUNCH_BUTTON_ID, subcommand as activity } from '../commands/activity.js'
import {
  autocompleteJSON,
  buttonJSON,
  commandJSON,
  dispatch,
  getCallback,
  makeSubcommands,
  primaryEntryPointJSON
} from './e2e.js'
import {
  ACTIVITY_ENTRY_COMMAND_NAME,
  applicationCommands,
  areApplicationCommandsCurrent
} from '../application-commands.js'

const subs = makeSubcommands(activity)

describe('activity command', () => {
  it('registers a Discord-managed Primary Entry Point', () => {
    expect(applicationCommands).toContainEqual(
      expect.objectContaining({
        name: ACTIVITY_ENTRY_COMMAND_NAME,
        type: ApplicationCommandType.PrimaryEntryPoint,
        handler: EntryPointCommandHandlerType.AppHandler
      })
    )
  })

  it('redeploys an existing Discord-managed Entry Point as app-handled', () => {
    const existing = applicationCommands.map((command) => ({
      name: command.name,
      type: command.type ?? ApplicationCommandType.ChatInput,
      ...('handler' in command
        ? { handler: EntryPointCommandHandlerType.DiscordLaunchActivity }
        : {})
    }))

    expect(areApplicationCommandsCurrent(existing)).toBe(false)
    expect(
      areApplicationCommandsCurrent(
        applicationCommands.map((command) => ({
          name: command.name,
          type: command.type ?? ApplicationCommandType.ChatInput,
          ...('handler' in command ? { handler: command.handler } : {})
        }))
      )
    ).toBe(true)
  })

  it('launches the Activity from the Primary Entry Point', async () => {
    const calls = await dispatch(primaryEntryPointJSON(), subs)
    const body = getCallback(calls) as { type: number }

    expect(body.type).toBe(InteractionResponseType.LaunchActivity)
  })

  it('creates a private Activity launch button', async () => {
    const calls = await dispatch(commandJSON('activity'), subs)
    const body = getCallback(calls) as {
      type: number
      data: { components: unknown[]; flags: number }
    }
    const rendered = JSON.stringify(body.data.components)

    expect(body.type).toBe(InteractionResponseType.ChannelMessageWithSource)
    expect(body.data.flags & MessageFlags.Ephemeral).toBeTruthy()
    expect(body.data.flags & MessageFlags.IsComponentsV2).toBeTruthy()
    expect(rendered).toContain('Hello World Activity')
    expect(rendered).toContain(ACTIVITY_LAUNCH_BUTTON_ID)
    expect(rendered).toContain('Open Activity')
  })

  it('responds to the button with LAUNCH_ACTIVITY', async () => {
    const firstCalls = await dispatch(commandJSON('activity'), subs)
    const firstBody = getCallback(firstCalls) as { data: { components: unknown[] } }

    const launchCalls = await dispatch(
      buttonJSON(firstBody.data.components, ACTIVITY_LAUNCH_BUTTON_ID),
      subs
    )
    const body = getCallback(launchCalls) as { type: number }

    expect(body.type).toBe(InteractionResponseType.LaunchActivity)
  })

  it('creates a public launcher with --pub', async () => {
    const calls = await dispatch(commandJSON('activity --pub'), subs)
    const body = getCallback(calls) as { data: { flags: number } }

    expect(body.data.flags & MessageFlags.Ephemeral).toBeFalsy()
  })

  it('returns activity in autocomplete', async () => {
    const calls = await dispatch(autocompleteJSON('act'), subs)
    const body = getCallback(calls) as { data: { choices: Array<{ value: string }> } }

    expect(body.data.choices.some((choice) => choice.value === 'activity')).toBe(true)
  })
})
