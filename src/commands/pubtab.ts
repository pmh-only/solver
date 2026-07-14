import { ActionRowBuilder, ButtonBuilder, ButtonStyle } from 'discord.js'
import type { Subcommand } from '../types.js'
import { constrainedCommandButton, PUBTAB_BUTTON_ID, sendPlainTextReply } from '../components.js'
import { createCanvasMedia } from '../canvas-presentation.js'

interface SafeCommand {
  label: string
  command: string
  args: string
}

function buildRows(safeCommands: SafeCommand[]) {
  const rows: ActionRowBuilder<ButtonBuilder>[] = []

  for (let index = 0; index < safeCommands.length; index += 5) {
    rows.push(
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        safeCommands
          .slice(index, index + 5)
          .map(({ label, command, args }) =>
            constrainedCommandButton(label, { command, args }, ButtonStyle.Secondary)
          )
      )
    )
  }

  return rows
}

export function createPubtabSubcommand(commands: Iterable<Subcommand>): Subcommand {
  const safeCommands = [...commands].flatMap((command) =>
    command.pubtab ? [{ ...command.pubtab, command: command.name }] : []
  )

  return {
    name: 'pubtab',
    description: 'public safe command tab',
    usage: 'pubtab',
    examples: ['pubtab'],

    async execute(interaction) {
      const payload = {
        content: 'Safe commands for anyone to run:',
        components: buildRows(safeCommands)
      }

      if (interaction.isButton() && interaction.customId === PUBTAB_BUTTON_ID) {
        const canvas = createCanvasMedia({
          id: 'pubtab',
          title: 'Public command tab',
          kicker: 'Safe for everyone',
          lines: ['Choose a command below, edit its arguments, then run it publicly.'],
          accent: 0x5865f2
        })
        await interaction.reply({ ...payload, files: [canvas.file] })
        return
      }

      await sendPlainTextReply(interaction, payload)
    }
  }
}
