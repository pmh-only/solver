import { promisify } from 'node:util'
import { gzip as gzipCallback } from 'node:zlib'
import { AttachmentBuilder, FileBuilder } from 'discord.js'
import type { Flags } from '../flags.js'
import type { Subcommand } from '../types.js'
import {
  deferCommandResponse,
  privateContainer,
  sendCommandReply,
  separator,
  summarySection,
  text
} from '../components.js'
import {
  aggregateOpenAIUsage,
  fetchOpenAIUsageReport,
  formatCosts,
  formatOpenAIUsageMarkdown,
  projectHasUsage,
  type OpenAIUsageReport,
  type ProjectUsageSummary
} from './usage-runtime.js'

const DEFAULT_DAYS = 30
const MAX_DAYS = 31
const MAX_PREVIEW_LENGTH = 3500
const MAX_ATTACHMENT_BYTES = 7_500_000
const MAX_COMPRESSION_INPUT_BYTES = 20_000_000
const gzip = promisify(gzipCallback)

function usageUserIds(value = process.env.OPENAI_USAGE_USER_IDS): Set<string> {
  return new Set((value ?? '').split(/[\s,]+/).filter(Boolean))
}

export function isUsageUserAllowed(userId: string, value?: string): boolean {
  return usageUserIds(value).has(userId)
}

function parseDays(flags: Flags): number | string {
  const value = flags.get('days')
  if (value === undefined) return DEFAULT_DAYS
  if (typeof value !== 'string' || !/^\d+$/.test(value)) return 'days must be an integer'

  const days = Number(value)
  return days >= 1 && days <= MAX_DAYS ? days : `days must be between 1 and ${MAX_DAYS}`
}

function formatInteger(value: number): string {
  return Math.round(value).toLocaleString('en-US')
}

function markdown(value: string): string {
  return value.replace(/([\\`*_[\]])/g, '\\$1')
}

function activity(summary: ProjectUsageSummary): number {
  return (
    Object.values(summary.costs).reduce((total, value) => total + value, 0) * 1_000_000 +
    summary.completionRequests +
    summary.embeddingRequests +
    summary.moderationRequests +
    summary.imageRequests +
    summary.speechRequests +
    summary.transcriptionRequests +
    summary.codeInterpreterSessions +
    summary.fileSearchCalls +
    summary.webSearchCalls
  )
}

function compactProject(summary: ProjectUsageSummary): string {
  if (!projectHasUsage(summary)) {
    return `- **${markdown(summary.name)}** · \`${summary.id}\` · no usage`
  }

  const tools = summary.codeInterpreterSessions + summary.fileSearchCalls + summary.webSearchCalls
  return [
    `- **${markdown(summary.name)}** · \`${summary.id}\` · ${formatCosts(summary.costs)}`,
    `  ${formatInteger(summary.completionRequests)} generation requests · ${formatInteger(summary.inputTokens)} in / ${formatInteger(summary.outputTokens)} out · ${formatInteger(tools)} tool calls`
  ].join('\n')
}

function projectPreview(summaries: ProjectUsageSummary[]): string {
  const sorted = [...summaries].sort(
    (left, right) => activity(right) - activity(left) || left.name.localeCompare(right.name)
  )
  const lines = ['**Projects**']
  let included = 0

  for (const summary of sorted) {
    const line = compactProject(summary)
    const suffix = `\n-# ${sorted.length - included - 1} more project(s) in the attached report`
    if ([...lines, line].join('\n').length + suffix.length > MAX_PREVIEW_LENGTH) break
    lines.push(line)
    included++
  }

  if (included < sorted.length) {
    lines.push(`-# ${sorted.length - included} more project(s) in the attached report`)
  }
  return lines.join('\n')
}

function totalCosts(summaries: ProjectUsageSummary[]): Record<string, number> {
  const totals: Record<string, number> = {}
  for (const summary of summaries) {
    for (const [currency, value] of Object.entries(summary.costs)) {
      totals[currency] = (totals[currency] ?? 0) + value
    }
  }
  return totals
}

async function reportAttachment(
  content: string,
  name: string,
  description: string
): Promise<AttachmentBuilder | null> {
  const plain = Buffer.from(content, 'utf8')
  if (plain.byteLength <= MAX_ATTACHMENT_BYTES) {
    return new AttachmentBuilder(plain, { name, description })
  }

  if (plain.byteLength > MAX_COMPRESSION_INPUT_BYTES) return null
  const compressed = await gzip(plain)
  if (compressed.byteLength <= MAX_ATTACHMENT_BYTES) {
    return new AttachmentBuilder(compressed, { name: `${name}.gz`, description })
  }
  return null
}

async function buildAttachments(report: OpenAIUsageReport, summaries: ProjectUsageSummary[]) {
  const date = new Date(report.generated_at * 1000).toISOString().slice(0, 10)
  const candidates = await Promise.all([
    reportAttachment(
      formatOpenAIUsageMarkdown(report, summaries),
      `openai-usage-${date}.md`,
      'Detailed OpenAI usage by project'
    ),
    reportAttachment(
      JSON.stringify(report),
      `openai-usage-${date}.json`,
      'Raw OpenAI usage buckets and dimensions'
    )
  ])
  return candidates.filter((file): file is AttachmentBuilder => file !== null)
}

function period(report: OpenAIUsageReport): string {
  return `${new Date(report.start_time * 1000).toISOString()} to ${new Date(report.end_time * 1000).toISOString()}`
}

async function privateReply(
  interaction: Parameters<Subcommand['execute']>[0],
  args: string,
  flags: Flags,
  ...components: Parameters<typeof privateContainer>[2][]
) {
  await sendCommandReply(interaction, privateContainer(args, flags, ...components))
}

export const subcommand: Subcommand = {
  name: 'usage',
  description: 'inspect detailed OpenAI usage for every project',
  usage: 'usage [--days <1-31>]',
  examples: ['usage', 'usage --days 7', 'usage --days 1'],
  flags: {
    days: { description: 'UTC days to include (default 30, maximum 31)', value: 'string' }
  },

  async execute(interaction, args, flags) {
    flags.delete('pub')

    if (!isUsageUserAllowed(interaction.user.id)) {
      await privateReply(
        interaction,
        args,
        flags,
        summarySection('OpenAI usage', ['Usage access is not configured for this Discord user.'])
      )
      return
    }

    const input = args.replace(/^\S+\s*/, '').trim()
    const days = parseDays(flags)
    if (input || typeof days === 'string') {
      const detail = input ? 'This command does not take positional arguments.' : String(days)
      await privateReply(
        interaction,
        args,
        flags,
        summarySection('OpenAI usage', [detail]),
        separator(),
        text(`**Syntax**\n\`${subcommand.usage}\``)
      )
      return
    }

    const apiKey = process.env.OPENAI_ADMIN_KEY
    if (!apiKey) {
      await privateReply(
        interaction,
        args,
        flags,
        summarySection('OpenAI usage', ['`OPENAI_ADMIN_KEY` is not configured.'])
      )
      return
    }

    await deferCommandResponse(interaction, flags)

    try {
      const report = await fetchOpenAIUsageReport(apiKey, days)
      const summaries = aggregateOpenAIUsage(report)
      const attachments = await buildAttachments(report, summaries)
      const active = summaries.filter(projectHasUsage).length
      const payload = privateContainer(
        args,
        flags,
        summarySection('OpenAI organization usage', [
          `-# period: ${period(report)} (end exclusive)`,
          `-# projects: ${summaries.length} total · ${active} with usage`,
          `-# cost: ${formatCosts(totalCosts(summaries))}`,
          `-# detail: ${attachments.length} attachment${attachments.length === 1 ? '' : 's'}`
        ]),
        separator(),
        text(projectPreview(summaries)),
        ...attachments.flatMap((attachment) =>
          attachment.name ? [new FileBuilder().setURL(`attachment://${attachment.name}`)] : []
        )
      )
      payload.files.push(...attachments)
      await sendCommandReply(interaction, payload)
    } catch (error) {
      const message = error instanceof Error ? error.message : 'OpenAI usage request failed'
      await privateReply(interaction, args, flags, summarySection('OpenAI usage failed', [message]))
    }
  }
}
