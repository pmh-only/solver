import { describe, expect, it } from 'vitest'
import { InteractionResponseType, MessageFlags } from 'discord.js'
import { formatRateLimitSamples, subcommand as ratelimitTest } from '../commands/ratelimit-test.js'
import { commandJSON, dispatch, getCallback, makeSubcommands } from './e2e.js'
import { interactionOriginalMessageRoute } from '../helpers/interaction-routes.js'

const subs = makeSubcommands(ratelimitTest)

describe('rate-limit diagnostic command', () => {
  it('matches Discord.js encoded original-response edit paths', () => {
    expect(interactionOriginalMessageRoute('application', 'token')).toBe(
      '/webhooks/application/token/messages/%40original'
    )
  })

  it('runs privately and cleans up its temporary follow-up', async () => {
    const calls = await dispatch(commandJSON('ratelimit-test'), subs, {
      postResult: (route) =>
        route.includes('/webhooks/')
          ? {
              id: '999999999999999999',
              channel_id: '777777777777777777',
              type: 0,
              content: '',
              embeds: [],
              components: [],
              attachments: [],
              flags: MessageFlags.Ephemeral
            }
          : {}
    })
    const callback = getCallback(calls) as { type: number; data: { flags: number } }
    const rendered = JSON.stringify(calls.at(-1)?.body)

    expect(callback.type).toBe(InteractionResponseType.DeferredChannelMessageWithSource)
    expect(callback.data.flags & MessageFlags.Ephemeral).toBeTruthy()
    expect(calls.filter(({ method }) => method === 'PATCH')).toHaveLength(6)
    expect(
      calls.some(
        ({ method, route }) => method === 'DELETE' && route.includes('/messages/999999999999999999')
      )
    ).toBe(true)
    expect(rendered).toContain('No REST response headers were captured')
  })

  it('formats matching bucket observations', () => {
    const rendered = formatRateLimitSamples([
      { label: 'original-1', bucket: 'bucket', limit: '5', remaining: '4', resetAfter: '2' },
      { label: 'follow-up-1', bucket: 'bucket', limit: '5', remaining: '4', resetAfter: '2' }
    ])

    expect(rendered).toContain('same bucket hash')
    expect(rendered).toContain('remaining 4')
  })

  it('rejects arguments without running the probe', async () => {
    const calls = await dispatch(commandJSON('ratelimit-test extra'), subs)

    expect(JSON.stringify(getCallback(calls))).toContain('ratelimit-test takes no arguments')
    expect(calls.filter(({ method }) => method === 'PATCH')).toHaveLength(0)
  })
})
