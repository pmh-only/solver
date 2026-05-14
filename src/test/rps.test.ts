import { join } from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import { InteractionResponseType, MessageFlags } from 'discord.js'
import {
  RPS_PICK_BUTTON_ID,
  RPS_PUBLISH_BUTTON_ID,
  subcommand as rps
} from '../commands/rps.js'
import { isolateStoredValues } from '../helpers/kv-store-test.js'
import { autocompleteJSON, buttonJSON, commandJSON, dispatch, getCallback, makeSubcommands } from './e2e.js'

const subs = makeSubcommands(rps)
const storePath = join(process.cwd(), '.tmp', 'rps.test.sqlite')

function otherUser() {
  return {
    id: '555555555555555555',
    username: 'otheruser',
    discriminator: '0',
    avatar: null,
    global_name: 'Other User'
  }
}

describe('rps — command', () => {
  beforeEach(() => {
    isolateStoredValues(storePath)
  })

  it('starts a private game against the PC', async () => {
    const calls = await dispatch(commandJSON('rps'), subs)
    const body = getCallback(calls) as { type: number; data: { components: unknown[]; flags: number } }

    expect(body.type).toBe(InteractionResponseType.ChannelMessageWithSource)
    expect(body.data.flags & MessageFlags.IsComponentsV2).toBeTruthy()
    expect(body.data.flags & MessageFlags.Ephemeral).toBeTruthy()
    expect(JSON.stringify(body.data.components)).toContain('Rock paper scissors')
    expect(JSON.stringify(body.data.components)).toContain('Publish duel')
  })

  it('plays a PC round from a choice button', async () => {
    const firstCalls = await dispatch(commandJSON('rps'), subs)
    const firstBody = getCallback(firstCalls) as { data: { components: unknown[] } }

    const pickCalls = await dispatch(buttonJSON(firstBody.data.components, RPS_PICK_BUTTON_ID), subs)
    const body = getCallback(pickCalls) as { type: number; data: { components: unknown[] } }
    const rendered = JSON.stringify(body.data.components)

    expect(body.type).toBe(InteractionResponseType.UpdateMessage)
    expect(rendered).toContain('PC:')
    expect(rendered).toContain('Pick again')
  })

  it('starts a public duel when --pub is set', async () => {
    const calls = await dispatch(commandJSON('rps --pub'), subs)
    const body = getCallback(calls) as { type: number; data: { components: unknown[]; flags: number } }
    const rendered = JSON.stringify(body.data.components)

    expect(body.type).toBe(InteractionResponseType.ChannelMessageWithSource)
    expect(body.data.flags & MessageFlags.IsComponentsV2).toBeTruthy()
    expect(body.data.flags & MessageFlags.Ephemeral).toBeFalsy()
    expect(rendered).toContain('Rock paper scissors duel')
    expect(rendered).not.toContain('Publish duel')
  })

  it('reveals a public duel after two users pick', async () => {
    const firstCalls = await dispatch(commandJSON('rps --pub'), subs)
    const firstBody = getCallback(firstCalls) as { data: { components: unknown[] } }

    const firstPickCalls = await dispatch(buttonJSON(firstBody.data.components, RPS_PICK_BUTTON_ID), subs)
    const firstPickBody = getCallback(firstPickCalls) as { data: { components: unknown[] } }

    expect(JSON.stringify(firstPickBody.data.components)).toContain('locked in a choice')

    const secondPickCalls = await dispatch(
      buttonJSON(firstPickBody.data.components, RPS_PICK_BUTTON_ID, { user: otherUser() }),
      subs
    )
    const secondPickBody = getCallback(secondPickCalls) as {
      type: number
      data: { components: unknown[] }
    }
    const rendered = JSON.stringify(secondPickBody.data.components)

    expect(secondPickBody.type).toBe(InteractionResponseType.UpdateMessage)
    expect(rendered).toContain('Test User: Rock')
    expect(rendered).toContain('Other User: Rock')
    expect(rendered).toContain('Draw')
  })

  it('publishes a private game as a public duel', async () => {
    const firstCalls = await dispatch(commandJSON('rps'), subs)
    const firstBody = getCallback(firstCalls) as { data: { components: unknown[] } }

    const publishCalls = await dispatch(
      buttonJSON(firstBody.data.components, RPS_PUBLISH_BUTTON_ID),
      subs
    )
    const body = getCallback(publishCalls) as { type: number; data: { components: unknown[]; flags: number } }

    expect(body.type).toBe(InteractionResponseType.ChannelMessageWithSource)
    expect(body.data.flags & MessageFlags.IsComponentsV2).toBeTruthy()
    expect(body.data.flags & MessageFlags.Ephemeral).toBeFalsy()
    expect(JSON.stringify(body.data.components)).toContain('Rock paper scissors duel')
  })
})

describe('rps — autocomplete', () => {
  it('returns rps as a choice when partially typed', async () => {
    const calls = await dispatch(autocompleteJSON('rp'), subs)
    const body = getCallback(calls) as { type: number; data: { choices: { value: string }[] } }

    expect(body.type).toBe(InteractionResponseType.ApplicationCommandAutocompleteResult)
    expect(body.data.choices.some((choice) => choice.value === 'rps')).toBe(true)
  })
})
