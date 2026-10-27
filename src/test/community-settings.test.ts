import { join } from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import {
  COMMUNITY_SETTINGS_KEY,
  loadCommunitySettings,
  manageCommunitySettings,
  manageCommunitySettingsSchema
} from '../community-settings.js'
import {
  clearStoredValues,
  getStoredValue,
  listStoredKeys,
  setStoredValue
} from '../helpers/kv-store.js'
import { isolateStoredValues } from '../helpers/kv-store-test.js'

const FIRST = '333333333333333333'
const SECOND = '444444444444444444'
const CHANNEL = '888888888888888888'

beforeEach(() => {
  isolateStoredValues(join(process.cwd(), '.tmp', 'community-settings.test.sqlite'))
  clearStoredValues()
})

describe('single global community configuration', () => {
  it('gets and updates without a guild ID and only writes one configuration key', () => {
    expect(manageCommunitySettingsSchema.shape).not.toHaveProperty('guildId')
    expect(manageCommunitySettings({ action: 'get' }).reactionForward).toBeNull()
    manageCommunitySettings({
      action: 'update',
      settings: {
        reactionForward: { channelId: CHANNEL },
        messageCommands: { prefix: '!' },
        roleChat: { roleId: FIRST }
      }
    })
    manageCommunitySettings({ action: 'update', settings: { inviteChannelId: CHANNEL } })
    expect(loadCommunitySettings()).toMatchObject({
      reactionForward: { channelId: CHANNEL },
      messageCommands: { prefix: '!', enabled: true },
      roleChat: { roleId: FIRST },
      inviteChannelId: CHANNEL
    })
    expect(listStoredKeys().filter((key) => key.startsWith('community:settings'))).toEqual([
      COMMUNITY_SETTINGS_KEY
    ])
  })

  it('ignores old callers supplying different guild IDs instead of creating scoped settings', () => {
    manageCommunitySettings({
      action: 'update',
      guildId: FIRST,
      settings: { anonymousName: 'one' }
    })
    manageCommunitySettings({
      action: 'update',
      guildId: SECOND,
      settings: { anonymousName: 'two' }
    })
    expect(manageCommunitySettings({ action: 'get', guildId: FIRST }).anonymousName).toBe('two')
    expect(getStoredValue(`community:settings:${FIRST}`)).toBeUndefined()
    expect(getStoredValue(`community:settings:${SECOND}`)).toBeUndefined()
  })

  it('automatically migrates one legacy configuration, including old role chat fields', () => {
    const previous = JSON.stringify({
      reactionForward: { channelId: CHANNEL },
      inviteChannelId: CHANNEL,
      messageCommands: { enabled: true, prefix: '!' },
      roleChat: { roleId: FIRST, cooldownSeconds: 30, requestsPerHour: 1 }
    })
    setStoredValue(`community:settings:${FIRST}`, previous)
    const settings = loadCommunitySettings()
    expect(settings).toMatchObject({
      reactionForward: { channelId: CHANNEL },
      messageCommands: { prefix: '!' },
      roleChat: { roleId: FIRST }
    })
    expect(settings.roleChat).not.toHaveProperty('cooldownSeconds')
    expect(settings.roleChat).not.toHaveProperty('requestsPerHour')
    expect(JSON.parse(getStoredValue(COMMUNITY_SETTINGS_KEY)!)).toEqual(settings)
    expect(getStoredValue(`community:settings:${FIRST}`)).toBe(previous)
  })

  it('uses the global configuration thereafter, even if old backups change', () => {
    setStoredValue(`community:settings:${FIRST}`, JSON.stringify({ anonymousName: 'legacy' }))
    expect(loadCommunitySettings().anonymousName).toBe('legacy')
    manageCommunitySettings({ action: 'update', settings: { anonymousName: 'global' } })
    setStoredValue(`community:settings:${FIRST}`, 'broken old backup')
    expect(loadCommunitySettings().anonymousName).toBe('global')
  })

  it('migrates equivalent legacy copies but refuses to silently merge conflicting configurations', () => {
    setStoredValue(`community:settings:${FIRST}`, JSON.stringify({ kickvoteThreshold: 5 }))
    setStoredValue(
      `community:settings:${SECOND}`,
      JSON.stringify({ kickvoteThreshold: 5, anonymousName: '???' })
    )
    expect(loadCommunitySettings().kickvoteThreshold).toBe(5)
    clearStoredValues()
    setStoredValue(`community:settings:${FIRST}`, JSON.stringify({ kickvoteThreshold: 5 }))
    setStoredValue(`community:settings:${SECOND}`, JSON.stringify({ kickvoteThreshold: 9 }))
    expect(loadCommunitySettings).toThrow('기존 서버 설정이 서로 다릅니다')
    expect(getStoredValue(COMMUNITY_SETTINGS_KEY)).toBeUndefined()
    expect(manageCommunitySettings({ action: 'reset' }).kickvoteThreshold).toBe(7)
  })

  it('resets globally without restoring legacy settings on subsequent reads', () => {
    setStoredValue(
      `community:settings:${FIRST}`,
      JSON.stringify({ anonymousName: 'legacy', kickvoteThreshold: 5 })
    )
    loadCommunitySettings()
    manageCommunitySettings({ action: 'reset' })
    expect(loadCommunitySettings()).toMatchObject({
      anonymousName: '???',
      kickvoteThreshold: 7,
      reactionForward: null
    })
    expect(getStoredValue(`community:settings:${FIRST}`)).toBeDefined()
  })

  it('fails closed on corrupt legacy/global settings and recovers through a global reset', () => {
    setStoredValue(`community:settings:${FIRST}`, 'broken')
    expect(loadCommunitySettings).toThrow()
    manageCommunitySettings({ action: 'reset' })
    setStoredValue(COMMUNITY_SETTINGS_KEY, '{broken')
    expect(loadCommunitySettings).toThrow()
    expect(manageCommunitySettings({ action: 'reset' }).disabledCommands).toEqual([])
  })

  it('resets feature data without requiring a server ID or clearing unrelated records', () => {
    for (const id of [FIRST, SECOND]) {
      setStoredValue(`community:message-bot:${id}`, '{}')
      setStoredValue(`community:reaction-forward:${id}`, '{}')
    }
    setStoredValue('community:transient:invite:private', 'keep')
    manageCommunitySettings({ action: 'update', settings: { anonymousName: 'keep-name' } })
    manageCommunitySettings({ action: 'reset-message-replies' })
    expect(listStoredKeys().some((key) => key.startsWith('community:message-bot:'))).toBe(false)
    expect(getStoredValue(`community:reaction-forward:${FIRST}`)).toBe('{}')
    manageCommunitySettings({ action: 'reset-reaction-forwards' })
    expect(listStoredKeys().some((key) => key.startsWith('community:reaction-forward:'))).toBe(
      false
    )
    expect(getStoredValue('community:transient:invite:private')).toBe('keep')
    expect(loadCommunitySettings().anonymousName).toBe('keep-name')
  })
})
