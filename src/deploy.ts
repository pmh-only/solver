import 'dotenv/config'
import { REST, Routes } from 'discord.js'
import { applicationCommands } from './application-commands.js'

const token = process.env.DISCORD_TOKEN
const clientId = process.env.DISCORD_CLIENT_ID

if (!token) throw new Error('no token')
if (!clientId) throw new Error('no client id')

const rest = new REST().setToken(token)

console.log('deploying...')
const data = await rest.put(Routes.applicationCommands(clientId), { body: applicationCommands })
console.log(`done: ${(data as unknown[]).length}`)
