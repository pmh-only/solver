import { beforeEach, describe, expect, it, vi } from 'vitest'
import { InteractionResponseType, MessageFlags } from 'discord.js'
import { adminUserIds, isAdminUser, requireAdminUserIds } from '../authorization.js'
import { COIN_GUESS_BUTTON_ID, subcommand as coin } from '../commands/coin.js'
import { subcommand as fileconv } from '../commands/fileconv.js'
import { createPubtabSubcommand } from '../commands/pubtab.js'
import { COMMAND_RUN_BUTTON_ID, COMMAND_RUN_INPUT_ID } from '../components.js'
import type { Subcommand } from '../types.js'
import {
  autocompleteJSON,
  buttonJSON,
  commandJSON,
  dispatch,
  getCallback,
  getEdit,
  makeSubcommands,
  modalJSON
} from './e2e.js'

const ADMIN_ID = '666666666666666666'
const SECOND_ADMIN_ID = '777777777777777777'

function user(id: string) {
  return {
    id,
    username: `user-${id}`,
    discriminator: '0',
    avatar: null,
    global_name: `User ${id}`
  }
}

const safeExecute = vi.fn<Subcommand['execute']>(async (interaction) => {
  if (interaction.deferred) {
    await interaction.editReply({ content: 'safe result' })
  } else {
    await interaction.reply({ content: 'safe result' })
  }
})

const safeCommand: Subcommand = {
  name: 'safe',
  description: 'safe public command',
  pubtab: { label: 'Safe', args: '' },
  execute: safeExecute
}

const pubtab = createPubtabSubcommand([safeCommand])
const subs = makeSubcommands(safeCommand, pubtab, coin)

beforeEach(() => {
  process.env.ADMIN_USER_IDS = `${ADMIN_ID}, ${SECOND_ADMIN_ID}`
  safeExecute.mockClear()
})

describe('interaction authorization', () => {
  it('parses multiple administrators and fails closed when unset', () => {
    const first = '111111111111111111'
    const second = '222222222222222222'
    const third = '333333333333333333'
    expect(adminUserIds(`${first}, ${second}\n${third}`)).toEqual(new Set([first, second, third]))
    expect(isAdminUser(second, `${first},${second}`)).toBe(true)
    expect(isAdminUser('444444444444444444', `${first},${second}`)).toBe(false)
    expect(isAdminUser(first, '')).toBe(false)
  })

  it('rejects missing and malformed administrator configuration at startup', () => {
    expect(() => requireAdminUserIds('')).toThrow('no admin user ids')
    expect(() => requireAdminUserIds('your_discord_user_id_here')).toThrow(
      'must contain only Discord user IDs'
    )
    expect(() => requireAdminUserIds(`${ADMIN_ID},bad`)).toThrow(
      'must contain only Discord user IDs'
    )
  })

  it('allows every configured administrator', async () => {
    const calls = await dispatch(commandJSON('safe', { user: user(SECOND_ADMIN_ID) }), subs)

    expect((getCallback(calls) as { type: number }).type).toBe(
      InteractionResponseType.ChannelMessageWithSource
    )
    expect(safeExecute).toHaveBeenCalledOnce()
  })

  it('silently ignores private commands from other users, including --pub', async () => {
    const nonAdmin = user('555555555555555555')

    expect(await dispatch(commandJSON('safe', { user: nonAdmin }), subs)).toEqual([])
    expect(await dispatch(commandJSON('safe --pub', { user: nonAdmin }), subs)).toEqual([])
    expect(safeExecute).not.toHaveBeenCalled()
  })

  it('blocks autocomplete from other users with no choices', async () => {
    const calls = await dispatch(autocompleteJSON('sa', { user: user('555555555555555555') }), subs)
    const body = getCallback(calls) as { type: number; data: { choices: unknown[] } }

    expect(body.type).toBe(InteractionResponseType.ApplicationCommandAutocompleteResult)
    expect(body.data.choices).toEqual([])
  })

  it('fails closed when ADMIN_USER_IDS is empty', async () => {
    process.env.ADMIN_USER_IDS = ''
    expect(await dispatch(commandJSON('safe'), subs)).toEqual([])
  })

  it('allows anyone to use controls attached to public messages', async () => {
    const firstCalls = await dispatch(commandJSON('coin --pub'), subs)
    const components = (getCallback(firstCalls) as { data: { components: unknown[] } }).data
      .components

    const calls = await dispatch(
      buttonJSON(components, COIN_GUESS_BUTTON_ID, {
        user: user('555555555555555555')
      }),
      subs
    )

    expect((getCallback(calls) as { type: number }).type).toBe(
      InteractionResponseType.UpdateMessage
    )
  })

  it('blocks other users from controls attached to private messages', async () => {
    const firstCalls = await dispatch(commandJSON('coin'), subs)
    const components = (getCallback(firstCalls) as { data: { components: unknown[] } }).data
      .components

    const calls = await dispatch(
      buttonJSON(
        components,
        COIN_GUESS_BUTTON_ID,
        { user: user('555555555555555555') },
        MessageFlags.Ephemeral
      ),
      subs
    )

    expect(calls).toEqual([])
  })

  it('allows anyone through a validated Pubtab modal flow', async () => {
    const nonAdmin = user('555555555555555555')
    const tabCalls = await dispatch(commandJSON('pubtab', { user: nonAdmin }), subs)
    const tabBody = getCallback(tabCalls) as { data: { components: unknown[] } }

    const openCalls = await dispatch(
      buttonJSON(tabBody.data.components, COMMAND_RUN_BUTTON_ID, { user: nonAdmin }),
      subs
    )
    const openBody = getCallback(openCalls) as { data: { custom_id: string } }

    const runCalls = await dispatch(
      modalJSON(
        '',
        { user: nonAdmin },
        { customId: openBody.data.custom_id, inputId: COMMAND_RUN_INPUT_ID }
      ),
      subs
    )

    expect((getCallback(runCalls) as { type: number }).type).toBe(
      InteractionResponseType.DeferredChannelMessageWithSource
    )
    expect(JSON.stringify(getEdit(runCalls))).toContain('safe result')
    expect(safeExecute).toHaveBeenCalledOnce()
  })

  it('rejects forged Pubtab modal IDs', async () => {
    const calls = await dispatch(
      modalJSON(
        '',
        { user: user('555555555555555555') },
        { customId: 'run-command-modal:missing', inputId: COMMAND_RUN_INPUT_ID }
      ),
      subs
    )

    expect(calls).toEqual([])
  })

  it('allows a non-admin to submit a public modal opened directly from Pubtab', async () => {
    const nonAdmin = user('555555555555555555')
    const directSubs = makeSubcommands(fileconv, createPubtabSubcommand([fileconv]))
    const tabCalls = await dispatch(commandJSON('pubtab', { user: nonAdmin }), directSubs)
    const tabBody = getCallback(tabCalls) as { data: { components: unknown[] } }

    const openCalls = await dispatch(
      buttonJSON(tabBody.data.components, COMMAND_RUN_BUTTON_ID, { user: nonAdmin }),
      directSubs
    )
    const openBody = getCallback(openCalls) as { type: number; data: { custom_id: string } }

    expect(openBody.type).toBe(InteractionResponseType.Modal)
    expect(openBody.data.custom_id).toBe('fileconv:choose:public')

    const submitCalls = await dispatch(
      modalJSON('', { user: nonAdmin }, { customId: 'fileconv:png:public' }),
      directSubs
    )

    expect((getCallback(submitCalls) as { type: number }).type).toBe(
      InteractionResponseType.DeferredChannelMessageWithSource
    )
    expect(getEdit(submitCalls)).not.toBeNull()
  })
})
