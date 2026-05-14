import { join } from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import { InteractionResponseType, MessageFlags } from 'discord.js'
import {
  POLL_BUTTON_ID,
  hash,
  json,
  jwt,
  poll,
  quote,
  short,
  time
} from '../commands/more.js'
import { clearStoredValues, getStoredValue } from '../helpers/kv-store.js'
import { isolateStoredValues } from '../helpers/kv-store-test.js'
import { buttonJSON, commandJSON, dispatch, getCallback, getEdit, makeSubcommands } from './e2e.js'

const subs = makeSubcommands(json, jwt, hash, time, short, quote, poll)
const storePath = join(process.cwd(), '.tmp', 'more.test.sqlite')

function base64Url(value: string): string {
  return Buffer.from(value).toString('base64url')
}

describe('more — utility commands', () => {
  beforeEach(() => {
    isolateStoredValues(storePath)
    clearStoredValues()
  })

  it('formats json through the rerunnable command path', async () => {
    const calls = await dispatch(commandJSON('json {"ok":true}'), subs)
    const callback = getCallback(calls) as { type: number; data: { flags: number } }
    const edit = getEdit(calls)
    const rendered = JSON.stringify(edit)

    expect(callback.type).toBe(InteractionResponseType.DeferredChannelMessageWithSource)
    expect(callback.data.flags & MessageFlags.Ephemeral).toBeTruthy()
    expect(rendered).toContain('valid JSON')
    expect(rendered).toContain('\\"ok\\": true')
  })

  it('decodes jwt without verification', async () => {
    const token = `${base64Url('{"alg":"none"}')}.${base64Url('{"sub":"123"}')}.`
    const calls = await dispatch(commandJSON(`jwt ${token}`), subs)
    const rendered = JSON.stringify(getEdit(calls))

    expect(rendered).toContain('decoded without verification')
    expect(rendered).toContain('\\"sub\\": \\"123\\"')
  })

  it('hashes text with a selected algorithm', async () => {
    const calls = await dispatch(commandJSON('hash hello --alg md5'), subs)
    const rendered = JSON.stringify(getEdit(calls))

    expect(rendered).toContain('5d41402abc4b2a76b9719d911017c592')
  })

  it('shows current time without arguments', async () => {
    const calls = await dispatch(commandJSON('time'), subs)
    const rendered = JSON.stringify(getEdit(calls))

    expect(rendered).toContain('Time')
    expect(rendered).toContain('utc')
  })

  it('stores and resolves local URL shortcuts', async () => {
    await dispatch(commandJSON('short https://example.com docs'), subs)

    expect(getStoredValue('short:docs')).toBe('https://example.com/')

    const calls = await dispatch(commandJSON('short docs'), subs)
    expect(JSON.stringify(getCallback(calls))).toContain('https://example.com/')
  })

  it('stores and retrieves quotes', async () => {
    await dispatch(commandJSON('quote motto ship it'), subs)

    const calls = await dispatch(commandJSON('quote motto'), subs)
    const rendered = JSON.stringify(getCallback(calls))

    expect(rendered).toContain('Quote motto')
    expect(rendered).toContain('ship it')
  })

  it('creates a button poll and records a vote', async () => {
    const firstCalls = await dispatch(commandJSON('poll Lunch? | ramen | sushi --pub'), subs)
    const firstBody = getCallback(firstCalls) as { type: number; data: { components: unknown[]; flags: number } }

    expect(firstBody.type).toBe(InteractionResponseType.ChannelMessageWithSource)
    expect(firstBody.data.flags & MessageFlags.IsComponentsV2).toBeTruthy()
    expect(JSON.stringify(firstBody.data.components)).toContain('Lunch?')

    const voteCalls = await dispatch(buttonJSON(firstBody.data.components, POLL_BUTTON_ID), subs)
    const voteBody = getCallback(voteCalls) as { type: number; data: { components: unknown[] } }

    expect(voteBody.type).toBe(InteractionResponseType.UpdateMessage)
    expect(JSON.stringify(voteBody.data.components)).toContain('1 vote')
  })
})
