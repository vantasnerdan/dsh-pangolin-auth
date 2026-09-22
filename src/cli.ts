/** Command-line interface for Pangolin profile setup and rollback. */

import { execFile as execFileCallback } from 'node:child_process'
import { promisify } from 'node:util'
import {
  restoreProfileBackup,
  setupProfile,
  uninstallProfile,
  type ProfileMutationResult,
} from './setup.ts'

const execFile = promisify(execFileCallback)
const EXPECTED_DSH_VERSION = '0.1.5-rc.2'

const USAGE = `Usage:
  dsh-pangolin-auth setup --profile <name> --domain <host[:port]> [--identity-header <name>]
  dsh-pangolin-auth uninstall --profile <name>
  dsh-pangolin-auth restore --profile <name> --backup <directory>

Stop the profile before setup, uninstall, or restore. Every successful change
requires restarting the profile. This package supports DSH ${EXPECTED_DSH_VERSION}.
`

class UsageError extends Error {}

interface ParsedArguments {
  command: 'setup' | 'uninstall' | 'restore'
  profile: string
  domain?: string
  identityHeader?: string
  backup?: string
}

function parseArguments(argv: readonly string[]): ParsedArguments | undefined {
  if (argv.length === 0 || argv.includes('--help') || argv.includes('-h')) return undefined
  const command = argv[0]
  if (command !== 'setup' && command !== 'uninstall' && command !== 'restore') {
    throw new UsageError(`unknown command ${JSON.stringify(command)}`)
  }
  const values = new Map<string, string>()
  for (let index = 1; index < argv.length; index += 2) {
    const option = argv[index]
    const value = argv[index + 1]
    if (option === undefined || value === undefined || !option.startsWith('--') || value.startsWith('--')) {
      throw new UsageError('options must use --name <value> pairs')
    }
    if (!['--profile', '--domain', '--identity-header', '--backup'].includes(option)) {
      throw new UsageError(`unknown option ${option}`)
    }
    if (values.has(option)) throw new UsageError(`option ${option} was provided more than once`)
    values.set(option, value)
  }
  const profile = values.get('--profile')
  if (profile === undefined) throw new UsageError('--profile is required')
  const domain = values.get('--domain')
  const identityHeader = values.get('--identity-header')
  const backup = values.get('--backup')
  if (command === 'setup') {
    if (domain === undefined) throw new UsageError('--domain is required for setup')
    if (backup !== undefined) throw new UsageError('--backup is valid only for restore')
    return {
      command,
      profile,
      domain,
      ...(identityHeader === undefined ? {} : { identityHeader }),
    }
  }
  if (domain !== undefined || identityHeader !== undefined) {
    throw new UsageError('--domain and --identity-header are valid only for setup')
  }
  if (command === 'restore') {
    if (backup === undefined) throw new UsageError('--backup is required for restore')
    return { command, profile, backup }
  }
  if (backup !== undefined) throw new UsageError('--backup is valid only for restore')
  return { command, profile }
}

async function assertCompatibleDsh(): Promise<void> {
  let stdout: string
  try {
    const result = await execFile('dsh', ['--version'], {
      encoding: 'utf8',
      timeout: 5_000,
      windowsHide: true,
    })
    stdout = result.stdout
  } catch (error) {
    throw new Error('pangolin-auth setup: unable to run dsh --version', { cause: error })
  }
  const actual = stdout.trim()
  if (actual !== EXPECTED_DSH_VERSION) {
    throw new Error(
      `pangolin-auth setup: requires DSH ${EXPECTED_DSH_VERSION}, found ${JSON.stringify(actual)}`,
    )
  }
}

function report(result: ProfileMutationResult): void {
  if (!result.changed) {
    console.log('Pangolin profile configuration is already in the requested state.')
    return
  }
  console.log('Pangolin profile configuration updated. Restart the profile before testing.')
  if (result.backupDir !== undefined) console.log(`Rollback backup: ${result.backupDir}`)
}

/** Run the setup CLI and return its process exit code. */
export async function main(argv: readonly string[]): Promise<number> {
  let parsed: ParsedArguments | undefined
  try {
    parsed = parseArguments(argv)
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    console.error(USAGE)
    return 2
  }
  if (parsed === undefined) {
    console.log(USAGE)
    return 0
  }
  try {
    await assertCompatibleDsh()
    if (parsed.command === 'setup') {
      report(await setupProfile({
        profile: parsed.profile,
        domain: parsed.domain ?? '',
        ...(parsed.identityHeader === undefined ? {} : { identityHeader: parsed.identityHeader }),
      }))
    } else if (parsed.command === 'uninstall') {
      report(await uninstallProfile({ profile: parsed.profile }))
    } else {
      report(await restoreProfileBackup({
        profile: parsed.profile,
        backupDir: parsed.backup ?? '',
      }))
    }
    return 0
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    return 1
  }
}
