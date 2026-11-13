import { spawn } from 'node:child_process'
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true }))
  )
})

describe('docker-entrypoint', () => {
  it('makes a Docker socket accessible when it appears after application startup', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'solver-entrypoint-'))
    temporaryDirectories.push(directory)
    const socketPath = join(directory, 'docker.sock')
    const fakeGosu = join(directory, 'gosu')
    await writeFile(fakeGosu, '#!/bin/sh\nshift\nexec "$@"\n')
    await chmod(fakeGosu, 0o755)

    const child = spawn(
      'sh',
      [
        resolve('docker-entrypoint.sh'),
        process.execPath,
        '-e',
        `setTimeout(() => console.log((require('node:fs').statSync(${JSON.stringify(socketPath)}).mode & 0o777).toString(8)), 500)`
      ],
      {
        env: {
          ...process.env,
          DOCKER_SOCKET_PATH: socketPath,
          PATH: `${directory}:${process.env.PATH}`
        }
      }
    )

    await new Promise((resolve) => setTimeout(resolve, 100))
    const server = createServer()
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(socketPath, resolve)
    })

    let output = ''
    child.stdout.on('data', (chunk) => {
      output += String(chunk)
    })
    const exitCode = await new Promise<number | null>((resolve, reject) => {
      child.once('error', reject)
      child.once('exit', resolve)
    })
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve()))
    )

    expect(exitCode).toBe(0)
    expect(output.trim()).toBe('666')
  })
})
