import type { Subcommand } from '../types.js'
import {
  codeBlock,
  commandReferenceReply,
  runRerunnableCommand,
  sendCommandReply,
  separator,
  summarySection,
  text
} from '../components.js'
import { executeCurl, parseCurlInvocation } from '../curl-runtime.js'

function formatCurlResult(result: Awaited<ReturnType<typeof executeCurl>> | string) {
  if (typeof result === 'string') {
    return [text(result)]
  }

  return [
    summarySection(
      `${result.request.method} ${result.request.originalTarget}`,
      result.error
        ? [`-# err: ${result.error}`]
        : [
            `-# status: ${result.status} ${result.statusText}`,
            `-# type: ${result.contentType}`,
            `-# final: ${result.finalUrl}`
          ],
      { label: 'Open response', url: result.finalUrl ?? result.request.url }
    ),
    separator(),
    text(
      [
        '**Request**',
        `-# url: ${result.request.url}`,
        `-# method: ${result.request.method}`,
        ...(Object.keys(result.request.headers).length > 0
          ? [
              `-# headers: ${Object.entries(result.request.headers)
                .map(([name, value]) => `${name}: ${value}`)
                .join(' | ')}`
            ]
          : []),
        ...(result.request.body ? [`-# body: ${result.request.body}`] : [])
      ].join('\n')
    ),
    codeBlock('Body preview', result.bodyPreview ?? result.error ?? 'no body', 'txt')
  ]
}

export const subcommand: Subcommand = {
  name: 'curl',
  description: 'web req',
  usage: 'curl <url> [--method <verb>] [--header <k:v>] [--data <body>] [--pub]',
  examples: [
    'curl https://example.com',
    'curl api.github.com --header "Accept: application/json"',
    'curl https://httpbin.org/post --method POST --data hello'
  ],

  flags: {
    method: { description: 'method', value: 'string', alias: 'X' },
    header: { description: 'header', value: 'string', alias: 'H' },
    data: { description: 'body', value: 'string', alias: 'd' }
  },

  async run(args, flags) {
    const parsed = parseCurlInvocation(args, flags)
    if ('error' in parsed) {
      throw new Error(parsed.error)
    }

    return formatCurlResult(await executeCurl(parsed))
  },

  async execute(interaction, args, flags) {
    const parsed = parseCurlInvocation(args, flags)
    if ('error' in parsed) {
      await sendCommandReply(
        interaction,
        commandReferenceReply(subcommand, args, flags, 'usage', parsed.error)
      )
      return
    }

    await runRerunnableCommand(interaction, subcommand, args, flags, async () =>
      subcommand.run!(args, flags)
    )
  }
}
