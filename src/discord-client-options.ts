import { GatewayIntentBits, type ClientOptions } from 'discord.js'

export const discordClientOptions: ClientOptions = {
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent
  ],
  allowedMentions: { parse: [], repliedUser: false }
}
