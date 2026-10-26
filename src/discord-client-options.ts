import { GatewayIntentBits, type ClientOptions } from 'discord.js'

export const discordClientOptions: ClientOptions = {
  intents: [GatewayIntentBits.Guilds],
  allowedMentions: { parse: [], repliedUser: false }
}
