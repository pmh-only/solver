import type { Subcommand } from '../types.js'
import {
  codeBlock,
  commandReferenceReply,
  runRerunnableCommand,
  sendCommandReply,
  separator,
  summarySection
} from '../components.js'
import { executeFirecrawlScrape, parseFirecrawlInvocation } from './_firecrawl.js'

function formatFirecrawlResult(result: Awaited<ReturnType<typeof executeFirecrawlScrape>>) {
  const pageUrl = result.sourceUrl ?? result.request.url
  const lines = result.ok
    ? [
        `-# status: ${result.status} ${result.statusText}`,
        `-# url: ${pageUrl}`,
        ...(result.title ? [`-# title: ${result.title}`] : [])
      ]
    : [
        `-# err: ${result.error ?? 'firecrawl failed'}`,
        ...(result.status ? [`-# status: ${result.status} ${result.statusText}`] : []),
        `-# url: ${pageUrl}`
      ]

  return [
    summarySection(`Crawl ${result.request.originalTarget}`, lines, {
      label: 'Open page',
      url: pageUrl
    }),
    separator(),
    codeBlock('Content preview', result.contentPreview ?? result.error ?? 'no content', 'md')
  ]
}

export const subcommand: Subcommand = {
  name: 'crawl',
  description: 'scrape page content',
  usage: 'crawl <url> [--pub]',
  examples: ['crawl pmh.codes', 'crawl https://example.com'],

  async run(args) {
    const parsed = parseFirecrawlInvocation(args)
    if ('error' in parsed) throw new Error(parsed.error)

    return formatFirecrawlResult(await executeFirecrawlScrape(parsed))
  },

  async execute(interaction, args, flags) {
    const parsed = parseFirecrawlInvocation(args)
    if ('error' in parsed) {
      await sendCommandReply(
        interaction,
        commandReferenceReply(subcommand, args, flags, 'usage', parsed.error)
      )
      return
    }

    await runRerunnableCommand(interaction, subcommand, args, flags, async () =>
      formatFirecrawlResult(await executeFirecrawlScrape(parsed))
    )
  }
}
