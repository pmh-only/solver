import { MessageFlags, RESTEvents, Routes, type APIRequest, type ResponseLike } from 'discord.js'
import { commandReferenceReply, sendCommandReply, text } from '../components.js'
import type { Subcommand } from '../types.js'

interface RateLimitSample {
  label: string
  bucket: string | null
  limit: string | null
  remaining: string | null
  resetAfter: string | null
}

function editProbePayload(label: string) {
  return {
    components: [text(`## Slash response rate-limit probe\n-# ${label}`)],
    flags: MessageFlags.IsComponentsV2 as const
  }
}

function followUpProbePayload(label: string) {
  return {
    components: editProbePayload(label).components,
    flags: [MessageFlags.IsComponentsV2, MessageFlags.Ephemeral] as const
  }
}

export function formatRateLimitSamples(samples: RateLimitSample[]): string {
  const buckets = new Set(samples.map(({ bucket }) => bucket).filter(Boolean))
  const conclusion =
    samples.length === 0
      ? 'No REST response headers were captured.'
      : buckets.size === 1
        ? 'The original response and follow-up returned the same bucket hash.'
        : 'The original response and follow-up returned different bucket hashes.'

  return [
    '## Slash response rate limits',
    `**${conclusion}**`,
    ...samples.map(
      ({ label, bucket, limit, remaining, resetAfter }) =>
        `- **${label}:** bucket \`${bucket ?? 'missing'}\`, limit ${limit ?? 'missing'}, remaining ${remaining ?? 'missing'}, reset-after ${resetAfter ?? 'missing'}s`
    )
  ].join('\n')
}

export const subcommand: Subcommand = {
  name: 'ratelimit-test',
  description: 'compare slash response and follow-up edit rate limits',
  usage: 'ratelimit-test',
  examples: ['ratelimit-test'],

  async execute(interaction, args, flags) {
    const restArgs = args.replace(/^\S+\s*/, '').trim()
    if (restArgs) {
      await sendCommandReply(
        interaction,
        commandReferenceReply(subcommand, args, flags, 'usage', 'ratelimit-test takes no arguments')
      )
      return
    }

    await interaction.deferReply({ flags: MessageFlags.Ephemeral })

    const originalPath = Routes.webhookMessage(interaction.applicationId, interaction.token)
    const samples: RateLimitSample[] = []
    let expectedPath: string = originalPath
    let pendingLabel: string | null = null
    let followUpId: string | null = null
    const listener = (request: APIRequest, response: ResponseLike) => {
      if (
        !pendingLabel ||
        request.method.toUpperCase() !== 'PATCH' ||
        String(request.path) !== expectedPath
      ) {
        return
      }
      samples.push({
        label: pendingLabel,
        bucket: response.headers.get('x-ratelimit-bucket'),
        limit: response.headers.get('x-ratelimit-limit'),
        remaining: response.headers.get('x-ratelimit-remaining'),
        resetAfter: response.headers.get('x-ratelimit-reset-after')
      })
    }
    interaction.client.rest.on(RESTEvents.Response, listener)

    const edit = async (label: string, path: string, action: () => Promise<unknown>) => {
      pendingLabel = label
      expectedPath = path
      try {
        await action()
      } finally {
        pendingLabel = null
      }
    }

    try {
      await edit('original-1', originalPath, () =>
        interaction.editReply(editProbePayload('original 1'))
      )
      const followUp = await interaction.followUp(followUpProbePayload('follow-up created'))
      followUpId = followUp.id
      const followUpPath = Routes.webhookMessage(
        interaction.applicationId,
        interaction.token,
        followUpId
      )

      await edit('original-2', originalPath, () =>
        interaction.editReply(editProbePayload('original 2'))
      )
      await edit('follow-up-1', followUpPath, () =>
        interaction.webhook.editMessage(followUpId!, editProbePayload('follow-up 1'))
      )
      await edit('original-3', originalPath, () =>
        interaction.editReply(editProbePayload('original 3'))
      )
      await edit('follow-up-2', followUpPath, () =>
        interaction.webhook.editMessage(followUpId!, editProbePayload('follow-up 2'))
      )
    } finally {
      interaction.client.rest.off(RESTEvents.Response, listener)
      if (followUpId) await interaction.webhook.deleteMessage(followUpId).catch(() => {})
    }

    await interaction.editReply({
      components: [text(formatRateLimitSamples(samples))],
      flags: MessageFlags.IsComponentsV2
    })
  }
}
