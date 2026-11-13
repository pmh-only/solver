import { DuckDBInstance, type DuckDBConnection } from '@duckdb/node-api'

const DB_OPTIONS = {
  threads: '2',
  memory_limit: '256MB',
  max_temp_directory_size: '0B',
  enable_external_access: 'false',
  autoinstall_known_extensions: 'false',
  autoload_known_extensions: 'false',
  allow_community_extensions: 'false'
}

/** Owns a connection and its instance, including failed opens and database switches. */
export class ArchiveDatabase implements Disposable {
  private instance?: DuckDBInstance
  private connection?: DuckDBConnection

  async open(path: string, accessMode: 'READ_ONLY' | 'READ_WRITE'): Promise<DuckDBConnection> {
    this[Symbol.dispose]()
    this.instance = await DuckDBInstance.create(path, { ...DB_OPTIONS, access_mode: accessMode })
    try {
      this.connection = await this.instance.connect()
      await this.connection.run('SET lock_configuration = true')
      return this.connection
    } catch (error) {
      this[Symbol.dispose]()
      throw error
    }
  }

  [Symbol.dispose](): void {
    const connection = this.connection
    const instance = this.instance
    this.connection = undefined
    this.instance = undefined
    try {
      connection?.closeSync()
    } finally {
      instance?.closeSync()
    }
  }
}
