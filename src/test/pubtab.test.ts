import { InteractionResponseType } from 'discord.js'
import { describe, expect, it } from 'vitest'
import { COMMAND_RUN_BUTTON_ID, COMMAND_RUN_INPUT_ID, COMMAND_RUN_MODAL_ID } from '../components.js'
import { subcommand as blackjack } from '../commands/blackjack.js'
import { subcommand as cert } from '../commands/cert.js'
import { subcommand as coin } from '../commands/coin.js'
import { subcommand as conv } from '../commands/conv.js'
import { subcommand as dice } from '../commands/dice.js'
import { subcommand as dig } from '../commands/dig.js'
import { subcommand as geoip } from '../commands/geoip.js'
import { subcommand as hilo } from '../commands/hilo.js'
import { subcommand as math } from '../commands/math.js'
import { subcommand as memory } from '../commands/memory.js'
import { createPubtabSubcommand } from '../commands/pubtab.js'
import { subcommand as quiz } from '../commands/quiz.js'
import { subcommand as rps } from '../commands/rps.js'
import { subcommand as run } from '../commands/run.js'
import { subcommand as sh } from '../commands/sh.js'
import { subcommand as slots } from '../commands/slots.js'
import { subcommand as ttt } from '../commands/ttt.js'
import { subcommand as whois } from '../commands/whois.js'
import type { Subcommand } from '../types.js'
import {
  buttonJSON,
  commandJSON,
  dispatch,
  getCallback,
  getEdit,
  makeSubcommands,
  modalJSON
} from './e2e.js'
import { runRerunnableCommand, text } from '../components.js'

const fakePing: Subcommand = {
  name: 'ping',
  description: 'fake ping',
  usage: 'ping <host> [--pub]',
  examples: ['ping 1.1.1.1'],
  pubtab: { label: 'Ping', args: '1.1.1.1' },
  async run(args) {
    return text(`pong ${args.replace(/^\S+\s*/, '').trim()}`)
  },
  async execute(interaction, args, flags) {
    await runRerunnableCommand(interaction, fakePing, args, flags, async () =>
      fakePing.run!(args, flags)
    )
  }
}

const commands = [
  fakePing,
  dig,
  whois,
  cert,
  geoip,
  math,
  conv,
  rps,
  dice,
  coin,
  slots,
  hilo,
  quiz,
  ttt,
  blackjack,
  memory,
  run,
  sh
]
const subs = makeSubcommands(...commands, createPubtabSubcommand(commands))

function findButtonByLabel(components: unknown[], label: string): string | null {
  const queue = [...components]

  while (queue.length > 0) {
    const current = queue.shift()
    if (!current || typeof current !== 'object') continue

    const record = current as { components?: unknown[]; custom_id?: unknown; label?: unknown }
    if (record.label === label && typeof record.custom_id === 'string') {
      return record.custom_id
    }

    if (Array.isArray(record.components)) {
      queue.push(...record.components)
    }
  }

  return null
}

describe('pubtab — command', () => {
  it('automatically shows registered safe command buttons in a public reply', async () => {
    const calls = await dispatch(commandJSON('pubtab'), subs)
    const body = getCallback(calls) as {
      type: number
      data: { content: string; components: Array<{ components?: Array<{ label?: string }> }> }
    }

    expect(body.type).toBe(InteractionResponseType.ChannelMessageWithSource)
    expect(body.data.content).toContain('Safe commands')

    const labels = body.data.components.flatMap((row) =>
      (row.components ?? []).map((component) => component.label)
    )

    expect(labels).toEqual([
      'Ping',
      'DNS',
      'Whois',
      'TLS',
      'GeoIP',
      'Math',
      'Convert',
      'RPS',
      'Dice',
      'Coin',
      'Slots',
      'High-Low',
      'Quiz',
      'TTT',
      'Blackjack',
      'Memory'
    ])
    expect(JSON.stringify(body)).not.toContain('run js')
    expect(JSON.stringify(body)).not.toContain('run shell')
  })

  it('opens a constrained modal and runs only that command on submit', async () => {
    const firstCalls = await dispatch(commandJSON('pubtab'), subs)
    const firstBody = getCallback(firstCalls) as { data: { components: unknown[] } }
    const customId = findButtonByLabel(firstBody.data.components, 'Math')

    expect(customId).toContain(`${COMMAND_RUN_BUTTON_ID}:`)

    const openCalls = await dispatch(buttonJSON(firstBody.data.components, customId ?? ''), subs)
    const openBody = getCallback(openCalls) as {
      type: number
      data: {
        custom_id: string
        title: string
        components: Array<{ components: Array<{ custom_id: string; value: string }> }>
      }
    }

    expect(openBody.type).toBe(InteractionResponseType.Modal)
    expect(openBody.data.custom_id).toContain(`${COMMAND_RUN_MODAL_ID}:`)
    expect(openBody.data.title).toBe('Run math')
    expect(JSON.stringify(openBody.data)).toContain(COMMAND_RUN_INPUT_ID)
    expect(JSON.stringify(openBody.data)).toContain('2*(3+4)')

    const runCalls = await dispatch(
      modalJSON('9*9', {}, { customId: openBody.data.custom_id, inputId: COMMAND_RUN_INPUT_ID }),
      subs
    )
    const runBody = getCallback(runCalls) as { type: number }
    const editBody = getEdit(runCalls) as { components: unknown[] }

    expect(runBody.type).toBe(InteractionResponseType.DeferredChannelMessageWithSource)
    expect(JSON.stringify(editBody.components)).toContain('Math result')
    expect(JSON.stringify(editBody.components)).toContain('81')
    expect(JSON.stringify(editBody.components)).toContain('math 9*9 --pub')
    expect(JSON.stringify(editBody.components)).not.toContain('run js')
  })

  it('submits rerunnable commands from the modal as a new reply', async () => {
    const firstCalls = await dispatch(commandJSON('pubtab'), subs)
    const firstBody = getCallback(firstCalls) as { data: { components: unknown[] } }
    const customId = findButtonByLabel(firstBody.data.components, 'Ping')

    const openCalls = await dispatch(buttonJSON(firstBody.data.components, customId ?? ''), subs)
    const openBody = getCallback(openCalls) as { data: { custom_id: string } }

    const runCalls = await dispatch(
      modalJSON(
        '8.8.8.8',
        {},
        { customId: openBody.data.custom_id, inputId: COMMAND_RUN_INPUT_ID }
      ),
      subs
    )
    const deferBody = getCallback(runCalls) as { type: number }

    expect(deferBody.type).toBe(InteractionResponseType.DeferredChannelMessageWithSource)
    expect(runCalls.some((call) => call.method === 'PATCH')).toBe(true)
    expect(JSON.stringify(runCalls)).toContain('ping 8.8.8.8 --pub')
    expect(JSON.stringify(runCalls)).not.toContain('Safe commands for anyone to run:')
  })
})
