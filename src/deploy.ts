import 'dotenv/config'
import { REST, Routes } from 'discord.js'
import {
  replaceApplicationCommands,
  type RegisteredApplicationCommand
} from './application-command-deployment.js'

const token = process.env.DISCORD_TOKEN
const clientId = process.env.DISCORD_CLIENT_ID

if (!token) throw new Error('no token')
if (!clientId) throw new Error('no client id')

const rest = new REST().setToken(token)

console.log('deploying...')
const existing = (await rest.get(
  Routes.applicationCommands(clientId)
)) as RegisteredApplicationCommand[]
const data = await replaceApplicationCommands(rest, clientId, existing)
console.log(`done: ${(data as unknown[]).length}`)
