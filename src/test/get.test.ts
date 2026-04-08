import { beforeEach, describe, expect, it } from 'vitest'
import { InteractionResponseType, MessageFlags } from 'discord.js'
import { join } from 'node:path'
import { PIN_BUTTON_ID, PUB_CONTENT_BUTTON_ID } from '../components.js'
import { subcommand as get } from '../commands/get.js'
import { clearStoredValues, setStoredValue } from '../helpers/kv-store.js'
import { isolateStoredValues } from '../helpers/kv-store-test.js'
import {
  autocompleteJSON,
  buttonJSON,
  commandJSON,
  dispatch,
  getCallback,
  makeSubcommands
} from './e2e.js'

const subs = makeSubcommands(get)
const storePath = join(process.cwd(), '.tmp', 'get.test.sqlite')

describe('get — command', () => {
  beforeEach(() => {
    isolateStoredValues(storePath)
    clearStoredValues()
  })

  it('reads a stored value and replies immediately', async () => {
    setStoredValue('a', 'b')

    const calls = await dispatch(commandJSON('get a'), subs)
    const body = getCallback(calls) as {
      type: number
      data: { content: string; components: unknown[]; flags: number }
    }

    expect(body.type).toBe(InteractionResponseType.ChannelMessageWithSource)
    expect(body.data.flags & MessageFlags.Ephemeral).toBeTruthy()
    expect(body.data.flags & MessageFlags.IsComponentsV2).toBeFalsy()
    expect(body.data.content).toBe('b')
    expect(JSON.stringify(body.data.components)).toContain('Publish')
  })

  it('returns a missing message when the key is absent', async () => {
    const calls = await dispatch(commandJSON('get a'), subs)
    const body = getCallback(calls) as { data: { content: string; flags: number } }

    expect(body.data.flags & MessageFlags.IsComponentsV2).toBeFalsy()
    expect(body.data.content).toBe('no a')
  })

  it('replies publicly when --pub is set', async () => {
    setStoredValue('a', 'b')

    const calls = await dispatch(commandJSON('get a --pub'), subs)
    const body = getCallback(calls) as {
      type: number
      data: { content: string; flags?: number; components?: unknown[] }
    }

    expect(body.type).toBe(InteractionResponseType.ChannelMessageWithSource)
    expect(body.data.flags ?? 0).toBe(0)
    expect(body.data.content).toBe('b')
    expect(body.data.components ?? []).toHaveLength(0)
  })

  it('publishes stored content as plain text from the publish button', async () => {
    setStoredValue('a', 'b')

    const firstCalls = await dispatch(commandJSON('get a'), subs)
    const firstBody = getCallback(firstCalls) as { data: { components: unknown[] } }
    const publishCalls = await dispatch(
      buttonJSON(firstBody.data.components, PUB_CONTENT_BUTTON_ID),
      subs
    )
    const body = getCallback(publishCalls) as { type: number; data: { content: string } }

    expect(body.type).toBe(InteractionResponseType.ChannelMessageWithSource)
    expect(body.data.content).toBe('b')
  })

  it('pins a non-v2 get reply without converting it to component v2', async () => {
    setStoredValue('a', 'b')

    const firstCalls = await dispatch(commandJSON('get a'), subs)
    const firstBody = getCallback(firstCalls) as { data: { components: unknown[] } }
    const pinCalls = await dispatch(buttonJSON(firstBody.data.components, PIN_BUTTON_ID), subs)
    const body = getCallback(pinCalls) as {
      type: number
      data: { components: unknown[]; flags?: number }
    }

    expect(body.type).toBe(InteractionResponseType.UpdateMessage)
    expect(body.data.flags).toBeUndefined()
    expect(JSON.stringify(body.data.components)).toContain('Pinned')
  })
})

describe('get — autocomplete (selection mode)', () => {
  it('returns get as a choice when partially typed', async () => {
    const calls = await dispatch(autocompleteJSON('ge'), subs)
    const body = getCallback(calls) as { type: number; data: { choices: { value: string }[] } }

    expect(body.type).toBe(InteractionResponseType.ApplicationCommandAutocompleteResult)
    expect(body.data.choices.some((c) => c.value === 'get')).toBe(true)
  })
})
