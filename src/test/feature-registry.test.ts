import { ApplicationCommandType, Collection, type Interaction } from 'discord.js'
import { describe, expect, it, vi } from 'vitest'
import { DiscordFeatureRegistry, type DiscordFeature } from '../feature-registry.js'
import { createFeatureRegistry } from '../features.js'
import { areApplicationCommandsCurrent } from '../application-commands.js'
import type { Subcommand } from '../types.js'

function interaction(): Interaction {
  return {} as Interaction
}

function feature(
  id: string,
  priority: number,
  matches: boolean,
  handle = vi.fn(async () => {})
): DiscordFeature {
  return {
    id,
    priority,
    commands: [{ name: id, type: ApplicationCommandType.ChatInput }],
    matches: () => matches,
    handle
  }
}

describe('Discord feature registry', () => {
  it('routes to the highest-priority matching feature', async () => {
    const registry = new DiscordFeatureRegistry()
    const additional = feature('additional', -100, true)
    const dynamic = feature('dynamic', 0, true)
    registry.register(additional)
    registry.register(dynamic)

    await registry.createHandler()(interaction())

    expect(dynamic.handle).toHaveBeenCalledOnce()
    expect(additional.handle).not.toHaveBeenCalled()
  })

  it('contains feature failures and invokes recovery once', async () => {
    const registry = new DiscordFeatureRegistry()
    const failure = new Error('feature failed')
    registry.register({
      ...feature('broken', 0, true),
      handle: vi.fn(async () => {
        throw failure
      })
    })
    const recover = vi.fn(async () => {})
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const currentInteraction = interaction()

    await expect(registry.createHandler(recover)(currentInteraction)).resolves.toBeUndefined()

    expect(recover).toHaveBeenCalledOnce()
    expect(recover).toHaveBeenCalledWith(currentInteraction, failure, 'broken')
  })

  it('releases commands and routes when a feature is unregistered', async () => {
    const registry = new DiscordFeatureRegistry()
    const fallback = feature('fallback', -100, true)
    const dynamic = feature('dynamic', 0, true)
    registry.register(fallback)
    registry.register(dynamic)

    expect(registry.unregister('dynamic')).toBe(true)
    expect(registry.commands.map(({ name }) => name)).toEqual(['fallback'])
    expect(registry.commands[0]?.default_member_permissions).toBe('0')
    await registry.createHandler()(interaction())
    expect(fallback.handle).toHaveBeenCalledOnce()
  })

  it('rejects duplicate feature and Discord command identities', () => {
    const registry = new DiscordFeatureRegistry()
    registry.register(feature('one', 0, false))

    expect(() => registry.register(feature('one', 1, false))).toThrow(
      'feature already registered: one'
    )
    expect(() =>
      registry.register({
        ...feature('two', 0, false),
        commands: [{ name: 'one', type: ApplicationCommandType.ChatInput }]
      })
    ).toThrow('application command already registered: 1:one')
  })

  it('composes the agent command before additional commands', () => {
    const registry = createFeatureRegistry(new Collection<string, Subcommand>())

    expect(registry.commands[0]?.name).toBe('a')
    expect(registry.commands[1]?.name).toBe('c')
  })

  it('detects stale definitions for dynamically registered slash commands', () => {
    const desired = [
      {
        name: 'dynamic',
        type: ApplicationCommandType.ChatInput,
        description: 'current description',
        options: []
      }
    ]

    expect(
      areApplicationCommandsCurrent(
        [
          {
            name: 'dynamic',
            type: ApplicationCommandType.ChatInput,
            description: 'stale description',
            options: []
          }
        ],
        desired
      )
    ).toBe(false)
  })
})
