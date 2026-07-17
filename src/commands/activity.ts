import { ButtonBuilder, ButtonStyle, SectionBuilder, type ButtonInteraction } from 'discord.js'
import { commandContainer, sendCommandReply, text } from '../components.js'
import type { Subcommand } from '../types.js'

export const ACTIVITY_LAUNCH_BUTTON_ID = 'activity-launch'

export function isActivityLaunchButtonId(customId: string): boolean {
  return customId === ACTIVITY_LAUNCH_BUTTON_ID
}

export async function handleActivityLaunchButton(interaction: ButtonInteraction): Promise<void> {
  await interaction.launchActivity()
}

export const subcommand: Subcommand = {
  name: 'activity',
  description: 'launch the Hello World Discord Activity',
  usage: 'activity [--pub]',
  examples: ['activity', 'activity --pub'],

  async autocomplete(restArgs) {
    if (!restArgs.includes(' ')) {
      return [{ name: 'Activity', value: 'activity' }]
    }
    return []
  },

  async execute(interaction, args, flags) {
    const launcher = new SectionBuilder()
      .addTextDisplayComponents(
        text('## Hello World Activity\nOpen a minimal web Activity inside Discord.')
      )
      .setButtonAccessory(
        new ButtonBuilder()
          .setCustomId(ACTIVITY_LAUNCH_BUTTON_ID)
          .setLabel('Open Activity')
          .setStyle(ButtonStyle.Primary)
      )

    await sendCommandReply(interaction, commandContainer(subcommand, args, flags, launcher))
  }
}
