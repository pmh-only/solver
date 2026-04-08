import { afterEach, describe, expect, it, vi } from 'vitest'
import { InteractionResponseType, MessageFlags } from 'discord.js'
import { subcommand as mail } from '../commands/mail.js'
import * as mailHelpers from '../helpers/mail.js'
import {
  autocompleteJSON,
  commandJSON,
  dispatch,
  getCallback,
  getEdit,
  makeSubcommands
} from './e2e.js'

const subs = makeSubcommands(mail)

afterEach(() => {
  vi.restoreAllMocks()
})

describe('mail - command', () => {
  it('defers ephemerally then edits with recent mail', async () => {
    vi.spyOn(mailHelpers, 'listRecentMail').mockResolvedValue([
      {
        uid: 42,
        subject: 'Quarterly update',
        from: 'Team <team@example.com>',
        date: '2026-04-08 12:00',
        seen: false
      }
    ])

    const calls = await dispatch(commandJSON('mail Inbox'), subs)
    const defer = getCallback(calls) as { type: number; data: { flags: number } }
    const edit = getEdit(calls)
    const text = JSON.stringify(edit)

    expect(defer.type).toBe(InteractionResponseType.DeferredChannelMessageWithSource)
    expect(defer.data.flags & MessageFlags.Ephemeral).toBeTruthy()
    expect(edit).not.toBeNull()
    expect(text).toContain('Quarterly update')
    expect(text).toContain('Select a message')
  })

  it('returns a usage-style detail when the mailbox is empty', async () => {
    vi.spyOn(mailHelpers, 'listRecentMail').mockResolvedValue([])

    const calls = await dispatch(commandJSON('mail Archive'), subs)
    const defer = getCallback(calls) as { type: number }
    const edit = getEdit(calls)

    expect(defer.type).toBe(InteractionResponseType.DeferredChannelMessageWithSource)
    expect(edit).not.toBeNull()
    expect(JSON.stringify(edit)).toContain('no mail in Archive')
  })

  it('passes parsed mailbox and clamped limit to the mail helper', async () => {
    const listSpy = vi.spyOn(mailHelpers, 'listRecentMail').mockResolvedValue([
      {
        uid: 7,
        subject: 'Status',
        from: 'Ops <ops@example.com>',
        date: '2026-04-08 08:30',
        seen: true
      }
    ])

    await dispatch(commandJSON('mail Sent --mailbox Archive --limit 50'), subs)

    expect(listSpy).toHaveBeenCalledWith('Archive', 25)
  })

  it('defers publicly when --pub flag is set', async () => {
    vi.spyOn(mailHelpers, 'listRecentMail').mockResolvedValue([
      {
        uid: 5,
        subject: 'Launch',
        from: 'Launch Team <launch@example.com>',
        date: '2026-04-08 09:00',
        seen: false
      }
    ])

    const calls = await dispatch(commandJSON('mail Inbox --pub'), subs)
    const defer = getCallback(calls) as { type: number; data: { flags: number } }

    expect(defer.type).toBe(InteractionResponseType.DeferredChannelMessageWithSource)
    expect(defer.data.flags & MessageFlags.Ephemeral).toBeFalsy()
  })
})

describe('mail - autocomplete', () => {
  it('returns mail in selection mode', async () => {
    const calls = await dispatch(autocompleteJSON('ma'), subs)
    const body = getCallback(calls) as { type: number; data: { choices: { value: string }[] } }

    expect(body.type).toBe(InteractionResponseType.ApplicationCommandAutocompleteResult)
    expect(body.data.choices.some((choice) => choice.value === 'mail')).toBe(true)
  })
})
