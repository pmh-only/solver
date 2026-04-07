import 'dotenv/config'
import { REST, Routes } from 'discord.js'
import { solverCommand } from './index.js'

const token = process.env.DISCORD_TOKEN
const clientId = process.env.DISCORD_CLIENT_ID

if (!token) throw new Error('no token')
if (!clientId) throw new Error('no client id')

const rest = new REST().setToken(token)

const body = [
  {
    ...solverCommand.toJSON(),
    integration_types: [0, 1],
    contexts: [0, 1, 2]
  }
]

console.log('deploying...')
const data = await rest.put(Routes.applicationCommands(clientId), { body })
console.log(`done: ${(data as unknown[]).length}`)
