/**
 * E2E test harness: raw Discord interaction JSON in → captured REST response JSON out.
 *
 * Interaction flow:
 *   dispatch(raw JSON) → creates real discord.js interaction objects
 *                      → runs the full handler (same as prod)
 *                      → intercepts client.rest calls instead of hitting Discord
 *                      → returns RestCall[]
 *
 * Response shape per interaction type:
 *   reply          → POST /interactions/{id}/{token}/callback  { type: 4, data: { components, flags } }
 *   deferReply     → POST /interactions/{id}/{token}/callback  { type: 5, data: { flags } }
 *   editReply      → PATCH /webhooks/{app_id}/{token}/messages/@original  { components, flags }
 *   autocomplete   → POST /interactions/{id}/{token}/callback  { type: 8, data: { choices } }
 */

import { AutocompleteInteraction, ChatInputCommandInteraction, Client, Collection } from 'discord.js'
import type { Interaction } from 'discord.js'
import { createHandler } from '../handler.js'
import type { Subcommand } from '../types.js'

export interface RestCall {
  method: 'POST' | 'PATCH'
  route: string
  body: unknown
}

/** Raw Discord API interaction object (partial — only fields the handler uses) */
export type RawInteraction = Record<string, unknown>

function makeClient(): { client: Client; calls: RestCall[] } {
  const client = new Client({ intents: [] })
  // @ts-expect-error set token without login
  client.token = 'test.token.here'

  const calls: RestCall[] = []

  ;(client.rest as unknown as Record<string, unknown>).post = async (route: unknown, options: { body?: unknown }) => {
    calls.push({ method: 'POST', route: String(route), body: options?.body ?? null })
    return {}
  }
  ;(client.rest as unknown as Record<string, unknown>).patch = async (route: unknown, options: { body?: unknown }) => {
    calls.push({ method: 'PATCH', route: String(route), body: options?.body ?? null })
    // discord.js editReply() expects a Message-like object back
    return { id: '0', type: 0, content: '', embeds: [], components: [], attachments: [], flags: 0 }
  }

  return { client, calls }
}

function buildInteraction(client: Client, raw: RawInteraction): Interaction {
  const type = raw.type as number
  if (type === 4) return new AutocompleteInteraction(client, raw as never)
  return new ChatInputCommandInteraction(client, raw as never)
}

/** Minimal raw JSON for a /c <value> chat input command */
export function commandJSON(value: string, overrides: Partial<RawInteraction> = {}): RawInteraction {
  return {
    id: '1000000000000000000',
    application_id: '999999999999999999',
    type: 2,
    data: {
      id: '888888888888888888',
      name: 'c',
      type: 1,
      options: [{ name: '_', value, type: 3 }],
    },
    channel_id: '777777777777777777',
    user: { id: '666666666666666666', username: 'testuser', discriminator: '0', avatar: null, global_name: 'Test User' },
    token: 'test_interaction_token',
    version: 1,
    locale: 'en-US',
    entitlements: [],
    authorizing_integration_owners: {},
    ...overrides,
  }
}

/** Minimal raw JSON for a /c <value> autocomplete interaction */
export function autocompleteJSON(value: string, overrides: Partial<RawInteraction> = {}): RawInteraction {
  return commandJSON(value, {
    type: 4,
    data: {
      id: '888888888888888888',
      name: 'c',
      type: 1,
      options: [{ name: '_', value, type: 3, focused: true }],
    },
    ...overrides,
  })
}

/** Run raw interaction JSON through the full handler, return captured REST calls */
export async function dispatch(raw: RawInteraction, subcommands: Collection<string, Subcommand>): Promise<RestCall[]> {
  const { client, calls } = makeClient()
  const handler = createHandler(subcommands)
  const interaction = buildInteraction(client, raw)
  await handler(interaction)
  return calls
}

/** Get the callback POST body — the primary response sent to Discord */
export function getCallback(calls: RestCall[]): unknown {
  return calls.find((c) => c.method === 'POST')?.body ?? null
}

/** Get the edit PATCH body — present only for deferred interactions */
export function getEdit(calls: RestCall[]): unknown {
  return calls.find((c) => c.method === 'PATCH')?.body ?? null
}

/** Build a subcommand collection from an array of subcommands */
export function makeSubcommands(...subs: Subcommand[]): Collection<string, Subcommand> {
  const col = new Collection<string, Subcommand>()
  for (const sub of subs) col.set(sub.name, sub)
  return col
}
