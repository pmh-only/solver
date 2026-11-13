import { describe, expect, it } from 'vitest'
import { interactionOriginalMessageRoute } from '../../../discord/routing/interaction-routes.js'

describe('interaction routes', () => {
  it('matches Discord.js encoded original-response edit paths', () => {
    expect(interactionOriginalMessageRoute('application', 'token')).toBe(
      '/webhooks/application/token/messages/%40original'
    )
  })
})
