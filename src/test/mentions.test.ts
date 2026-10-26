import { MessageFlags } from 'discord.js'
import { describe, expect, it } from 'vitest'
import { container } from '../components.js'
import type { Subcommand } from '../types.js'
import { commandJSON, dispatch, makeSubcommands } from './e2e.js'

const mentions = '<@666666666666666666> <@&555555555555555555> @everyone @here'
const blockedMentions = { parse: [], replied_user: false }

describe('global mention policy', () => {
  it.each(['', ' --pub'])('blocks mentions in initial Components V2 replies%s', async (suffix) => {
    const command: Subcommand = {
      name: 'mention-test',
      description: 'test mention policy',
      async execute(interaction, args, flags) {
        await interaction.reply(container(args, flags, mentions))
      }
    }

    const calls = await dispatch(commandJSON(`mention-test${suffix}`), makeSubcommands(command))
    const callback = calls.find((call) => call.route.endsWith('/callback'))?.body as {
      data: { allowed_mentions: unknown; components: unknown; flags: number }
    }

    expect(callback.data.allowed_mentions).toEqual(blockedMentions)
    expect(JSON.stringify(callback.data.components)).toContain(mentions)
    expect(Boolean(callback.data.flags & MessageFlags.Ephemeral)).toBe(!suffix)
  })

  it('blocks mentions in deferred edits and follow-ups without per-response options', async () => {
    const command: Subcommand = {
      name: 'mention-test',
      description: 'test mention policy',
      async execute(interaction, args, flags) {
        await interaction.deferReply()
        const payload = container(args, flags, mentions)
        await interaction.editReply({
          components: payload.components,
          flags: MessageFlags.IsComponentsV2
        })
        await interaction.followUp(payload)
        await interaction.followUp(mentions)
      }
    }

    const calls = await dispatch(commandJSON('mention-test --pub'), makeSubcommands(command), {
      postResult: () => ({
        id: '1000000000000000001',
        type: 0,
        content: '',
        embeds: [],
        components: [],
        attachments: [],
        flags: 0
      })
    })
    const messages = calls.filter((call) => !call.route.endsWith('/callback'))

    expect(messages).toHaveLength(3)
    for (const call of messages) {
      expect(call.body).toMatchObject({ allowed_mentions: blockedMentions })
      expect(JSON.stringify(call.body)).toContain(mentions)
    }
  })
})
