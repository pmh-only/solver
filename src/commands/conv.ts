import type { Subcommand } from '../types.js'
import {
  commandContainer,
  commandReferenceReply,
  deferCommandResponse,
  sendCommandReply,
  separator,
  summarySection,
  text
} from '../components.js'
import { convertValue, inspectConvRequest } from './conv_core.js'

function formatConvResult(input: string, output: string) {
  const request = inspectConvRequest(input)
  const kind =
    request.kind === 'currency'
      ? 'Currency conversion'
      : request.kind === 'number'
        ? 'Base conversion'
        : 'Byte conversion'

  return [
    summarySection(kind, ['Conversion completed']),
    separator(),
    text(`**Input**\n\`${input}\``),
    text(`**Result**\n\`${output}\``)
  ]
}

export const subcommand: Subcommand = {
  name: 'conv',
  description: 'convert',
  usage: 'conv <value> to <unit> [--pub]',
  examples: ['conv 15 usd to eur', 'conv 255 to hex', 'conv hello to base64'],

  async execute(interaction, args, flags) {
    const restArgs = args.replace(/^\S+\s*/, '').trim()

    if (!restArgs) {
      await sendCommandReply(
        interaction,
        commandReferenceReply(subcommand, args, flags, 'usage', 'no args')
      )
      return
    }

    try {
      const request = inspectConvRequest(restArgs)

      if (request.kind === 'currency') {
        await deferCommandResponse(interaction, flags)
        const result = await convertValue(restArgs)
        const reply = commandContainer(
          subcommand,
          args,
          flags,
          ...formatConvResult(restArgs, result)
        )
        await sendCommandReply(interaction, reply)
        return
      }

      const result = await convertValue(restArgs)
      await sendCommandReply(
        interaction,
        commandContainer(subcommand, args, flags, ...formatConvResult(restArgs, result))
      )
    } catch (error) {
      const message = error instanceof Error ? error.message : 'conv err'
      await sendCommandReply(
        interaction,
        commandReferenceReply(subcommand, args, flags, 'usage', message)
      )
    }
  }
}
