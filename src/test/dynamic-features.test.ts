import { ApplicationCommandType, Collection, MessageFlags, type Interaction } from 'discord.js'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DynamicDiscordFeatureManager, type DynamicFeatureInvocation } from '../dynamic-features.js'
import { DiscordFeatureRegistry } from '../feature-registry.js'
import {
  DISCORD_FEATURES_KEY,
  loadStoredDiscordFeatures
} from '../helpers/discord-feature-store.js'
import { getStoredValue, isInternalStoredKey, setStoredValue } from '../helpers/kv-store.js'
import { isolateStoredValues } from '../helpers/kv-store-test.js'
import type { CommandInteraction, Subcommand } from '../types.js'

const storePath = join(process.cwd(), '.tmp', 'dynamic-features.test.sqlite')

function interaction(overrides: Record<string, unknown> = {}): Interaction {
  return {
    user: { id: '666666666666666666' },
    commandName: '',
    isChatInputCommand: () => false,
    isAutocomplete: () => false,
    isMessageComponent: () => false,
    isModalSubmit: () => false,
    isStringSelectMenu: () => false,
    isUserContextMenuCommand: () => false,
    isMessageContextMenuCommand: () => false,
    ...overrides
  } as unknown as Interaction
}

function runtime() {
  const registry = new DiscordFeatureRegistry()
  const fallback = vi.fn(async () => {})
  registry.register({
    id: 'additional',
    priority: -100,
    commands: [{ name: 'c', type: ApplicationCommandType.ChatInput }],
    matches: () => true,
    handle: fallback
  })
  const subcommands = new Collection<string, Subcommand>()
  subcommands.set('static', {
    name: 'static',
    description: 'static command',
    execute: vi.fn(async () => {})
  })
  const run = vi.fn(async (_invocation: DynamicFeatureInvocation) => {})
  const syncCommands = vi.fn(async () => {})
  const cleanup = vi.fn()
  const recover = vi.fn(async () => {})
  const manager = new DynamicDiscordFeatureManager({
    registry,
    subcommands,
    run,
    syncCommands,
    cleanup,
    recover
  })
  manager.initialize()
  return { registry, subcommands, fallback, run, syncCommands, cleanup, recover, manager }
}

beforeEach(() => {
  isolateStoredValues(storePath)
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('dynamic Discord features', () => {
  it('creates and immediately executes a persistent /c feature', async () => {
    const { manager, subcommands, run, syncCommands } = runtime()

    await expect(
      manager.manage({
        action: 'upsert',
        id: 'summarize',
        kind: 'command',
        name: 'summarize',
        description: 'summarize supplied text',
        instructions: 'Summarize the supplied arguments in three bullets.'
      })
    ).resolves.toBe('Created command Discord feature summarize as /c summarize.')

    const command = subcommands.get('summarize')!
    const commandInteraction = { user: { id: '666666666666666666' } } as CommandInteraction
    await command.execute(commandInteraction, 'summarize a long report', new Map([['pub', true]]))

    expect(run).toHaveBeenCalledWith(
      expect.objectContaining({
        feature: expect.objectContaining({ id: 'summarize' }),
        interaction: commandInteraction,
        input: JSON.stringify({
          type: 'command',
          arguments: 'a long report',
          flags: { pub: true }
        }),
        pub: true
      })
    )
    expect(syncCommands).toHaveBeenCalledOnce()
    expect(loadStoredDiscordFeatures()).toEqual([
      expect.objectContaining({ id: 'summarize', kind: 'command' })
    ])
    expect(isInternalStoredKey(DISCORD_FEATURES_KEY)).toBe(true)
  })

  it('creates a JavaScript /c feature and executes it without the agent', async () => {
    const { manager, subcommands, run } = runtime()
    await manager.manage({
      action: 'upsert',
      id: 'hello',
      kind: 'command',
      name: 'hello',
      description: 'say hello',
      code: 'return args ? `안녕 ${args}` : "안녕"'
    })
    const editReply = vi.fn(async () => ({ id: 'dynamic-code-response' }))
    const commandInteraction = {
      user: { id: '666666666666666666' },
      deferred: false,
      replied: false,
      isButton: () => false,
      isStringSelectMenu: () => false,
      isModalSubmit: () => false,
      deferReply: vi.fn(async () => {
        commandInteraction.deferred = true
      }),
      editReply,
      deleteReply: vi.fn(async () => {})
    } as unknown as CommandInteraction

    await subcommands.get('hello')!.execute(commandInteraction, 'hello 민수', new Map())

    expect(run).not.toHaveBeenCalled()
    expect(commandInteraction.deferReply).toHaveBeenCalledWith({ flags: MessageFlags.Ephemeral })
    expect(JSON.stringify(editReply.mock.calls)).toContain('안녕 민수')
    expect(loadStoredDiscordFeatures()).toEqual([
      expect.objectContaining({ id: 'hello', code: expect.stringContaining('return args') })
    ])
  })

  it('registers, routes, persists, and removes a user context feature', async () => {
    const { manager, registry, run, syncCommands, cleanup } = runtime()
    await manager.manage({
      action: 'upsert',
      id: 'profile',
      kind: 'user',
      name: 'Profile Summary',
      description: 'summarize a user profile',
      instructions: 'Summarize the selected user profile.'
    })

    expect(registry.commands).toContainEqual(
      expect.objectContaining({ name: 'Profile Summary', type: ApplicationCommandType.User })
    )
    const target = { id: '555555555555555555', username: 'target' }
    await registry.createHandler()(
      interaction({
        commandName: 'Profile Summary',
        isUserContextMenuCommand: () => true,
        targetUser: { toJSON: () => target }
      })
    )

    expect(run).toHaveBeenCalledWith(
      expect.objectContaining({
        feature: expect.objectContaining({ id: 'profile' }),
        input: JSON.stringify({ type: 'user_context', target_user: target }),
        pub: false
      })
    )

    const second = runtime()
    expect(second.manager.list()).toEqual([expect.objectContaining({ id: 'profile' })])
    expect(second.registry.commands).toContainEqual(
      expect.objectContaining({ name: 'Profile Summary', type: ApplicationCommandType.User })
    )

    await expect(manager.manage({ action: 'remove', id: 'profile' })).resolves.toBe(
      'Removed Discord feature profile.'
    )
    expect(registry.commands).not.toContainEqual(
      expect.objectContaining({ name: 'Profile Summary' })
    )
    expect(syncCommands).toHaveBeenCalledTimes(2)
    expect(cleanup).toHaveBeenCalledWith(expect.objectContaining({ id: 'profile' }))
  })

  it('does not execute context features for non-admin users', async () => {
    const { manager, registry, run } = runtime()
    await manager.manage({
      action: 'upsert',
      id: 'inspect-message',
      kind: 'message',
      name: 'Inspect Message',
      description: 'inspect a selected message',
      instructions: 'Inspect the selected message.'
    })

    await registry.createHandler()(
      interaction({
        user: { id: '777777777777777777' },
        commandName: 'Inspect Message',
        isMessageContextMenuCommand: () => true,
        targetMessage: { toJSON: () => ({ id: 'message-1', content: 'hello' }) }
      })
    )

    expect(run).not.toHaveBeenCalled()
  })

  it('passes selected message data to an authorized message feature', async () => {
    const { manager, registry, run } = runtime()
    await manager.manage({
      action: 'upsert',
      id: 'inspect-message',
      kind: 'message',
      name: 'Inspect Message',
      description: 'inspect a selected message',
      instructions: 'Inspect the selected message.'
    })
    const target = { id: 'message-1', content: 'hello from the target' }

    await registry.createHandler()(
      interaction({
        commandName: 'Inspect Message',
        isMessageContextMenuCommand: () => true,
        targetMessage: { toJSON: () => target }
      })
    )

    expect(run).toHaveBeenCalledWith(
      expect.objectContaining({
        feature: expect.objectContaining({ id: 'inspect-message' }),
        input: JSON.stringify({ type: 'message_context', target_message: target }),
        pub: false
      })
    )
  })

  it('contains a dynamic /c runtime failure and delegates one recovery attempt', async () => {
    const { manager, subcommands, run, recover } = runtime()
    await manager.manage({
      action: 'upsert',
      id: 'fragile',
      kind: 'command',
      name: 'fragile',
      description: 'a fragile command',
      instructions: 'Complete the request safely.'
    })
    const failure = new Error('runtime failed')
    run.mockRejectedValueOnce(failure)
    const commandInteraction = { user: { id: '666666666666666666' } } as CommandInteraction

    await expect(
      subcommands.get('fragile')!.execute(commandInteraction, 'fragile input', new Map())
    ).resolves.toBeUndefined()

    expect(recover).toHaveBeenCalledWith(commandInteraction, failure, 'dynamic /c fragile input')
  })

  it('rejects static command collisions and rolls back failed deployment', async () => {
    const { manager, subcommands, syncCommands } = runtime()
    await expect(
      manager.manage({
        action: 'upsert',
        id: 'collision',
        kind: 'command',
        name: 'static',
        description: 'conflicts with a static command',
        instructions: 'Never installed.'
      })
    ).rejects.toThrow('/c command already registered: static')
    expect(manager.list()).toEqual([])
    expect(subcommands.get('static')?.description).toBe('static command')

    syncCommands.mockRejectedValueOnce(new Error('Discord deployment failed'))
    await expect(
      manager.manage({
        action: 'upsert',
        id: 'temporary',
        kind: 'command',
        name: 'temporary',
        description: 'temporary feature',
        instructions: 'Never committed after deployment failure.'
      })
    ).rejects.toThrow('Discord deployment failed')
    expect(manager.list()).toEqual([])
    expect(subcommands.has('temporary')).toBe(false)
    expect(loadStoredDiscordFeatures()).toEqual([])
    expect(syncCommands).toHaveBeenCalledTimes(2)
  })

  it('ignores corrupt persisted manifests', () => {
    setStoredValue(DISCORD_FEATURES_KEY, '{broken')
    const { manager } = runtime()
    expect(manager.list()).toEqual([])
    expect(getStoredValue(DISCORD_FEATURES_KEY)).toBe('{broken')
  })

  it('keeps removal successful while reporting cleanup work to the agent', async () => {
    const { manager, cleanup } = runtime()
    await manager.manage({
      action: 'upsert',
      id: 'cleanup-test',
      kind: 'command',
      name: 'cleanup-test',
      description: 'test cleanup failures',
      instructions: 'Return a test response.'
    })
    cleanup.mockImplementationOnce(() => {
      throw new Error('session cleanup failed')
    })

    await expect(manager.manage({ action: 'remove', id: 'cleanup-test' })).resolves.toContain(
      'Cleanup needs repair: cleanup-test: session cleanup failed'
    )
    expect(manager.list()).toEqual([])
  })
})
