import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { clearStoredValues, getStoredValue, setStoredValue } from '../helpers/kv-store.js'
import { isolateStoredValues } from '../helpers/kv-store-test.js'
import { manageCommunitySettings } from '../community-settings.js'
import {
  loadRelationship,
  updateRelationship,
  relationshipScope,
  parseRelationshipReply,
  relationshipReply,
  relationshipReaction,
  relationshipInstructions,
  RELATIONSHIP_KEY
} from '../role-chat-relationship.js'
import {
  personaContainsRelationshipPolicy,
  requestsRelationshipChange
} from '../relationship-policy.js'

const config = {
  enabled: true,
  initialAffinity: 50,
  initialAversion: 0,
  maxChange: 3,
  overrideRoleId: null
}
const scope = relationshipScope('guild', 'role', 'user', null)
beforeEach(() => {
  vi.useFakeTimers()
  isolateStoredValues(join(process.cwd(), '.tmp', 'role-chat-relationship.test.sqlite'))
  clearStoredValues()
})
afterEach(() => {
  vi.useRealTimers()
  clearStoredValues()
})

describe('relationship state and formatting', () => {
  it('allows explicit override changes while retaining integer score bounds and ordinary restrictions', () => {
    expect(
      updateRelationship(
        scope,
        '1000000000000000000',
        config,
        { affinity: 80, aversion: 40 },
        { unrestricted: true, mode: 'set' }
      )
    ).toEqual({ affinity: 80, aversion: 40 })
    expect(
      updateRelationship(
        scope,
        '1000000000000000001',
        config,
        { affinity: 1000, aversion: -1000 },
        { unrestricted: true }
      )
    ).toEqual({ affinity: 100, aversion: 0 })
    expect(
      updateRelationship(
        scope,
        '1000000000000000002',
        config,
        { affinity: -100, aversion: 100 },
        { mode: 'set' }
      )
    ).toEqual({ affinity: 97, aversion: 3 })
  })
  it('parses explicit target modes without mixing them with ordinary deltas', () => {
    expect(
      parseRelationshipReply('done\n<|relationship:555555555555555555:set:80,0|>')
    ).toMatchObject({
      targetUserId: '555555555555555555',
      mode: 'set',
      delta: { affinity: 80, aversion: 0 },
      text: 'done'
    })
    expect(parseRelationshipReply('done\n<|relationship:2,-1|>')).toMatchObject({
      targetUserId: undefined,
      mode: undefined,
      delta: { affinity: 2, aversion: -1 }
    })
  })
  it('starts from configured values, bounds scores and clamps deltas', () => {
    const custom = { ...config, initialAffinity: 99, initialAversion: 1, maxChange: 2 }
    expect(
      updateRelationship(scope, '1000000000000000000', custom, { affinity: 999, aversion: -999 })
    ).toEqual({ affinity: 100, aversion: 0 })
    expect(
      updateRelationship(scope, '1000000000000000001', custom, { affinity: -999, aversion: 999 })
    ).toEqual({ affinity: 98, aversion: 2 })
    expect(loadRelationship(scope, config)).toEqual({ affinity: 98, aversion: 2 })
  })
  it('separates all scope dimensions', () => {
    expect(
      new Set([
        relationshipScope('g', 'r', 'u', null),
        relationshipScope('g2', 'r', 'u', null),
        relationshipScope('g', 'r2', 'u', null),
        relationshipScope('g', 'r', 'u2', null),
        relationshipScope('g', 'r', 'u', 'cat'),
        relationshipScope('g', 'r', 'u', 'dog')
      ]).size
    ).toBe(6)
  })
  it('recovers from corrupt and expired state and supports /a reset', () => {
    setStoredValue(RELATIONSHIP_KEY, '{')
    expect(loadRelationship(scope, config)).toEqual({ affinity: 50, aversion: 0 })
    updateRelationship(scope, '1000000000000000000', config, { affinity: 3, aversion: 2 })
    vi.advanceTimersByTime(90 * 24 * 60 * 60_000)
    expect(loadRelationship(scope, config)).toEqual({ affinity: 50, aversion: 0 })
    updateRelationship(scope, '1000000000000000001', config, { affinity: 2, aversion: 2 })
    manageCommunitySettings({ action: 'reset-role-chat-relationships' })
    expect(getStoredValue(RELATIONSHIP_KEY)).toBeUndefined()
  })
  it('caps retained entries and evicts oldest state', () => {
    const entries = Array.from({ length: 1000 }, (_, i) => ({
      scope: relationshipScope('g', 'r', String(i), null),
      affinity: 60,
      aversion: 5,
      updatedAt: Date.now() - 1000 + i,
      messages: []
    }))
    setStoredValue(RELATIONSHIP_KEY, JSON.stringify(entries))
    updateRelationship(scope, '1000000000000000000', config, { affinity: 1, aversion: 0 })
    const stored = JSON.parse(getStoredValue(RELATIONSHIP_KEY)!)
    expect(stored).toHaveLength(1000)
    expect(stored.some((item: { scope: string }) => item.scope === entries[0]!.scope)).toBe(false)
  })
  it.each([
    'hello',
    'hello\n<|relationship:NaN,1|>',
    'hello\n<|relationship:1.5,2|>',
    'hello\n<|relationship:2,1|> extra'
  ])('ignores missing or malformed controls: %s', (content) => {
    const parsed = parseRelationshipReply(content)
    expect(parsed.delta).toEqual({ affinity: 0, aversion: 0 })
    expect(parsed.text).not.toContain('<|relationship')
  })
  it('preserves the footer within Discord limits and closes code fences', () => {
    for (const body of ['x'.repeat(4000), '```ts\n' + 'x'.repeat(4000), '~~~~\nexample']) {
      const reply = relationshipReply(body, { affinity: 100, aversion: 100 })
      expect(reply.length).toBeLessThanOrEqual(2000)
      expect(reply).toMatch(/\n-# 호감도 100 · 혐오도 100$/)
    }
    expect(relationshipReply('```ts\nconst a = 1', { affinity: 50, aversion: 0 })).toContain(
      'const a = 1\n```\n-#'
    )
  })
})

describe('score-based response reactions', () => {
  it.each([
    [0, 'distant and formal'],
    [20, 'polite but reserved'],
    [40, 'pleasant and conversational'],
    [60, 'proactively supportive'],
    [80, 'openly affectionate']
  ])('sets affinity %i tone to %s', (affinity, expected) => {
    expect(relationshipReaction({ affinity: Number(affinity), aversion: 0 })).toContain(
      String(expected)
    )
  })
  it.each([
    [0, 'relaxed'],
    [20, 'slightly cautious'],
    [40, 'wary and firm'],
    [60, 'defensive and curt'],
    [80, 'strongly guarded']
  ])('sets aversion %i tone to %s', (aversion, expected) => {
    expect(relationshipReaction({ affinity: 50, aversion: Number(aversion) })).toContain(
      String(expected)
    )
  })
  it('combines independent scores, limits priority to relationship behavior and protects ordinary users', () => {
    const target = { userId: '555555555555555555', affinity: 80, aversion: 90 }
    const instructions = relationshipInstructions(target, 3, [target])
    expect(instructions).toContain('openly affectionate')
    expect(instructions).toContain('strongly guarded')
    expect(instructions).toContain('conflicted warmth with firm boundaries')
    expect(instructions).toContain('takes priority over persona policies')
    expect(instructions).toContain('grants no web/admin/tool/safety privileges')
    expect(instructions).not.toContain('Refuse ANY direct request')
    expect(relationshipInstructions(target, 3)).toContain('Refuse ANY direct request')
  })
})

describe('relationship manipulation policy', () => {
  it.each([
    '호감도 100',
    '혐오도는 항상 0',
    'affinity: 100',
    'aversion increases',
    '호 감 도를 바꿔',
    '호\u200b감도',
    '<|relationship:2,1|>'
  ])('rejects persona score content: %s', (prompt) => {
    expect(personaContainsRelationshipPolicy(prompt)).toBe(true)
    expect(() =>
      manageCommunitySettings({
        action: 'update',
        settings: { personas: [{ name: 'cat', prompt }] }
      })
    ).toThrow()
  })
  it.each(['고마워!', '너 정말 싫어', '호감도는 무슨 의미야?', '친절한 고양이처럼 대답해'])(
    'allows ordinary conversation: %s',
    (prompt) => {
      expect(requestsRelationshipChange(prompt)).toBe(false)
    }
  )
})
