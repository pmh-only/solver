import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MessageFlags, InteractionResponseType } from 'discord.js'
import {
  cancelEphemeralDelete,
  commandContainer,
  container,
  sendCommandReply,
  sendPlainTextReply
} from '../../../discord/ui/components.js'
import { clearStoredValues } from '../../../shared/storage/kv-store.js'
import type { Subcommand } from '../../../discord/commands/types.js'
import {
  buttonJSON,
  commandJSON,
  dispatch,
  getCallback,
  getEdit,
  makeSubcommands,
  modalJSON
} from '../../support/e2e.js'

beforeEach(() => {
  clearStoredValues()
  vi.useFakeTimers()
})
afterEach(() => {
  cancelEphemeralDelete('0')
  cancelEphemeralDelete('1000000000000000123')
  clearStoredValues()
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('shared interaction delivery', () => {
  it('schedules a follow-up deletion by its own message ID after an initial reply', async () => {
    const command: Subcommand = {
      name: 'delivery',
      description: 'delivery test',
      async execute(interaction) {
        await interaction.reply(container('first', new Map([['pub', true]]), 'first'))
        await sendCommandReply(interaction, container('second', new Map(), 'second'))
      }
    }
    const calls = await dispatch(commandJSON('delivery'), makeSubcommands(command), {
      postResult: (route) =>
        route.startsWith('/webhooks/')
          ? {
              id: '1000000000000000123',
              type: 0,
              content: '',
              components: [],
              attachments: [],
              embeds: [],
              flags: MessageFlags.Ephemeral
            }
          : undefined
    })
    const followUp = calls.find(
      (call) => call.method === 'POST' && call.route.startsWith('/webhooks/')
    )
    expect(followUp?.body).toMatchObject({
      flags: MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral
    })
    await vi.advanceTimersByTimeAsync(60_000)
    expect(calls.filter((call) => call.method === 'DELETE').map((call) => call.route)).toEqual([
      expect.stringContaining('/messages/1000000000000000123')
    ])
  })

  it.each(['components', 'text'])(
    'acknowledges source-message modals before editing %s output',
    async (kind) => {
      const command: Subcommand = {
        name: 'delivery',
        description: 'delivery test',
        async execute(interaction) {
          if (kind === 'text')
            await sendPlainTextReply(interaction, {
              content: 'result',
              flags: MessageFlags.Ephemeral
            })
          else await sendCommandReply(interaction, container('delivery', new Map(), 'result'))
        }
      }
      const calls = await dispatch(
        modalJSON('delivery', { message: buttonJSON([]).message }),
        makeSubcommands(command)
      )
      expect(getCallback(calls)).toMatchObject({
        type: InteractionResponseType.DeferredMessageUpdate
      })
      if (kind === 'text') expect(getEdit(calls)).toMatchObject({ content: 'result' })
      else expect(getEdit(calls)).toMatchObject({ flags: MessageFlags.IsComponentsV2 })
      await vi.advanceTimersByTimeAsync(60_000)
      expect(calls.some((call) => call.method === 'DELETE')).toBe(true)
    }
  )

  it('updates an unacknowledged Retry component when its command throws', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    let attempts = 0
    const command: Subcommand = {
      name: 'delivery',
      description: 'delivery test',
      async execute(interaction, args, flags) {
        if (attempts++) throw new Error('retry failed')
        await sendCommandReply(interaction, commandContainer(command, args, flags, 'ready'))
      }
    }
    const subs = makeSubcommands(command)
    const first = getCallback(await dispatch(commandJSON('delivery'), subs)) as {
      data: { components: unknown[] }
    }
    const calls = await dispatch(buttonJSON(first.data.components), subs)
    expect(getCallback(calls)).toMatchObject({
      type: InteractionResponseType.UpdateMessage,
      data: { flags: MessageFlags.IsComponentsV2 }
    })
    expect(JSON.stringify(getCallback(calls))).toContain('retry failed')
  })
})
