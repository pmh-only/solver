import { describe, expect, it } from 'vitest'
import { ComponentType, MessageFlags } from 'discord.js'
import {
  container,
  extractCommandInputFromComponents,
  hasEphemeralFlag,
  matchesInteractiveId
} from '../components.js'

describe('canvas command presentation', () => {
  it('does not create images for text-only command output', () => {
    const reply = container('math 1+1', new Map(), '2')
    const components = reply.components.map((component) => component.toJSON()) as Array<{
      type?: number
    }>

    expect(components[0]?.type).toBe(ComponentType.Container)
    expect(JSON.stringify(components)).not.toContain(`"type":${ComponentType.MediaGallery}`)
    expect(JSON.stringify(components)).not.toContain('accent_color')
    expect(reply.files).toHaveLength(0)
  })
})

describe('hasEphemeralFlag', () => {
  it('returns true when number has ephemeral bit set', () => {
    expect(hasEphemeralFlag(MessageFlags.Ephemeral)).toBe(true)
  })

  it('returns false when number does not have ephemeral bit', () => {
    expect(hasEphemeralFlag(MessageFlags.IsComponentsV2)).toBe(false)
  })

  it('returns true when array includes ephemeral', () => {
    expect(hasEphemeralFlag([MessageFlags.IsComponentsV2, MessageFlags.Ephemeral])).toBe(true)
  })

  it('returns false when array does not include ephemeral', () => {
    expect(hasEphemeralFlag([MessageFlags.IsComponentsV2])).toBe(false)
  })

  it('returns false for 0', () => {
    expect(hasEphemeralFlag(0)).toBe(false)
  })
})

describe('matchesInteractiveId', () => {
  it('returns true for exact match', () => {
    expect(matchesInteractiveId('retry', 'retry')).toBe(true)
  })

  it('returns true for prefixed match with colon separator', () => {
    expect(matchesInteractiveId('retry:abc123', 'retry')).toBe(true)
  })

  it('returns false for partial match without colon', () => {
    expect(matchesInteractiveId('retry-other', 'retry')).toBe(false)
  })

  it('returns false for completely unrelated id', () => {
    expect(matchesInteractiveId('pub', 'retry')).toBe(false)
  })

  it('returns false when base is a prefix of id but not colon-delimited', () => {
    expect(matchesInteractiveId('retrying', 'retry')).toBe(false)
  })
})

describe('extractCommandInputFromComponents', () => {
  it('returns null for null input', () => {
    expect(extractCommandInputFromComponents(null)).toBeNull()
  })

  it('returns null when no footer pattern present', () => {
    // Pass a single container object — the function traverses .components keys, not array indices
    const container = { type: 17, components: [{ type: 10, content: 'some plain output' }] }
    expect(extractCommandInputFromComponents(container)).toBeNull()
  })

  it('extracts command from -# `...` footer pattern in a container', () => {
    const container = {
      type: 17,
      components: [{ type: 10, content: 'some output\n\n-# `ping 1.1.1.1 --type http`' }]
    }
    expect(extractCommandInputFromComponents(container)).toBe('ping 1.1.1.1 --type http')
  })

  it('returns the last footer match when multiple backtick patterns present', () => {
    const container = {
      type: 17,
      components: [{ type: 10, content: '-# `ping first`\n\n-# `ping second`' }]
    }
    expect(extractCommandInputFromComponents(container)).toBe('ping second')
  })

  it('extracts command from deeply nested components', () => {
    const container = {
      type: 17,
      components: [
        {
          type: 9,
          components: [{ type: 10, content: 'inner\n\n-# `dig example.com --pub`' }]
        }
      ]
    }
    expect(extractCommandInputFromComponents(container)).toBe('dig example.com --pub')
  })

  it('traverses accessory field', () => {
    const container = {
      type: 9,
      accessory: { type: 10, content: '-# `curl https://example.com`' }
    }
    expect(extractCommandInputFromComponents(container)).toBe('curl https://example.com')
  })
})
