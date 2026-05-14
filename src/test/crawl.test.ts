import { afterEach, describe, expect, it, vi } from 'vitest'
import { InteractionResponseType, MessageFlags } from 'discord.js'
import { subcommand as crawl } from '../commands/crawl.js'
import * as firecrawl from '../commands/_firecrawl.js'
import {
  autocompleteJSON,
  commandJSON,
  dispatch,
  getCallback,
  getEdit,
  makeSubcommands
} from './e2e.js'

const subs = makeSubcommands(crawl)

function mockFirecrawlResult(): firecrawl.FirecrawlScrapeResult {
  return {
    ok: true,
    request: {
      originalTarget: 'pmh.codes',
      url: 'https://pmh.codes/'
    },
    status: 200,
    statusText: 'OK',
    title: 'pmh.codes',
    sourceUrl: 'https://pmh.codes/',
    contentPreview: '# Home\nHello world'
  }
}

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  delete process.env.FIRECRAWL_API_KEY
})

describe('crawl — command', () => {
  it('replies immediately with usage when url is missing', async () => {
    const calls = await dispatch(commandJSON('crawl'), subs)
    const body = getCallback(calls) as { type: number; data: { flags: number } }

    expect(body.type).toBe(InteractionResponseType.ChannelMessageWithSource)
    expect(body.data.flags & MessageFlags.Ephemeral).toBeTruthy()
    expect(JSON.stringify(body)).toContain('no url')
  })

  it('defers ephemerally then edits with scraped content', async () => {
    const executeSpy = vi
      .spyOn(firecrawl, 'executeFirecrawlScrape')
      .mockResolvedValue(mockFirecrawlResult())

    const calls = await dispatch(commandJSON('crawl pmh.codes'), subs)
    const defer = getCallback(calls) as { type: number; data: { flags: number } }
    const edit = getEdit(calls)

    expect(defer.type).toBe(InteractionResponseType.DeferredChannelMessageWithSource)
    expect(defer.data.flags & MessageFlags.Ephemeral).toBeTruthy()
    expect(edit).not.toBeNull()
    expect(JSON.stringify(edit)).toContain('Hello world')
    expect(executeSpy).toHaveBeenCalledWith({
      originalTarget: 'pmh.codes',
      url: 'https://pmh.codes/'
    })
  })

  it('defers publicly when --pub flag is set', async () => {
    vi.spyOn(firecrawl, 'executeFirecrawlScrape').mockResolvedValue(mockFirecrawlResult())

    const calls = await dispatch(commandJSON('crawl pmh.codes --pub'), subs)
    const defer = getCallback(calls) as { type: number; data: { flags: number } }

    expect(defer.type).toBe(InteractionResponseType.DeferredChannelMessageWithSource)
    expect(defer.data.flags & MessageFlags.Ephemeral).toBeFalsy()
  })
})

describe('crawl — autocomplete', () => {
  it('returns crawl in selection mode', async () => {
    const calls = await dispatch(autocompleteJSON('cr'), subs)
    const body = getCallback(calls) as { type: number; data: { choices: { value: string }[] } }

    expect(body.type).toBe(InteractionResponseType.ApplicationCommandAutocompleteResult)
    expect(body.data.choices.some((choice) => choice.value === 'crawl')).toBe(true)
  })
})

describe('crawl — firecrawl runtime', () => {
  it('sends a Firecrawl scrape request with the env api key', async () => {
    process.env.FIRECRAWL_API_KEY = 'test-key'
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          success: true,
          data: {
            markdown: '# Home',
            metadata: { title: 'Home', sourceURL: 'https://pmh.codes/' }
          }
        }),
        { status: 200, statusText: 'OK' }
      )
    )
    vi.stubGlobal('fetch', fetchMock)

    const result = await firecrawl.executeFirecrawlScrape({
      originalTarget: 'pmh.codes',
      url: 'https://pmh.codes/'
    })

    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.firecrawl.dev/v2/scrape',
      expect.objectContaining({
        method: 'POST',
        headers: {
          Authorization: 'Bearer test-key',
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ url: 'https://pmh.codes/' })
      })
    )
    expect(result.ok).toBe(true)
    expect(result.contentPreview).toBe('# Home')
    expect(result.title).toBe('Home')
  })
})
