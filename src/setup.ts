/** Transactional profile configuration for the Pangolin connection bundle. */

import { randomUUID } from 'node:crypto'
import { lstat, mkdir, open, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { JSON_SCHEMA, Type, loadAll } from 'js-yaml'
import { assertTrustedAuthority } from './api-request-trust.ts'
import { resolveIdentityHeader } from './pangolin-auth.ts'

const PACKAGE_NAME = 'dsh-pangolin-auth'
const BEGIN_MARKER = '# >>> dsh-pangolin-auth managed setup v1; do not edit'
const END_MARKER = '# <<< dsh-pangolin-auth managed setup v1'
const PROFILE_NAME_PATTERN = /^[A-Za-z0-9._-]+$/u
const JS_TYPE = new Type('tag:yaml.org,2002:js', {
  kind: 'scalar',
  construct: value => ({ __jsExpr: value ?? '' }),
})
const PATCH_SCHEMA = JSON_SCHEMA.extend([JS_TYPE])

interface ProfileManifest {
  name?: string
  private?: boolean
  dependencies?: Record<string, string>
  dsh?: {
    profile?: {
      bundles?: string[]
      patchReload?: string
    }
  }
  [key: string]: unknown
}

/** Result of one setup, uninstall, or restore operation. */
export interface ProfileMutationResult {
  /** Whether profile files changed. */
  changed: boolean
  /** Backup directory containing the pre-mutation file contents. */
  backupDir?: string
}

/** Values accepted by the setup operation. */
export interface SetupOptions {
  /** Harness home. Defaults to `DSH_HOME`, then `~/.dsh`. */
  dshHome?: string
  /** Existing profile name. */
  profile: string
  /** Public Pangolin authority as bare `host` or `host:port`. */
  domain: string
  /** Pangolin identity header. */
  identityHeader?: string
}

/** Values accepted by uninstall. */
export interface UninstallOptions {
  /** Harness home. Defaults to `DSH_HOME`, then `~/.dsh`. */
  dshHome?: string
  /** Existing profile name. */
  profile: string
}

function harnessHome(explicit?: string): string {
  return resolve(explicit ?? process.env.DSH_HOME ?? join(homedir(), '.dsh'))
}

function profileDirectory(dshHome: string | undefined, profile: string): string {
  if (!PROFILE_NAME_PATTERN.test(profile) || ['.', '..', 'node_modules'].includes(profile)) {
    throw new Error('pangolin-auth setup: profile must be one safe profile name')
  }
  return join(harnessHome(dshHome), 'profiles', profile)
}

async function assertProfileDirectory(path: string, profile: string): Promise<void> {
  const profileStat = await lstat(path).catch(() => {
    throw new Error(`pangolin-auth setup: profile ${JSON.stringify(profile)} does not exist`)
  })
  if (!profileStat.isDirectory() || profileStat.isSymbolicLink()) {
    throw new Error('pangolin-auth setup: profile path must be a real directory')
  }
}

/** Validate and normalize a public Pangolin authority. */
export function resolveDomain(value: string): string {
  assertTrustedAuthority(value)
  if (!/^[\x21-\x7e]+$/u.test(value) || value.includes('*') || value.includes('_') || value.includes('%')) {
    throw new Error('pangolin-auth setup: domain must use canonical ASCII host syntax')
  }
  const url = new URL(`https://${value}`)
  const canonical = url.host.toLowerCase()
  const hostname = url.hostname.toLowerCase()
  if (canonical !== value.toLowerCase() || hostname.endsWith('.') || url.port === '0') {
    throw new Error('pangolin-auth setup: domain must be a canonical host[:port] authority')
  }
  if (!hostname.startsWith('[')) {
    const labels = hostname.split('.')
    if (labels.some(label => label.length === 0
      || label.length > 63
      || !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/u.test(label))) {
      throw new Error('pangolin-auth setup: domain contains an invalid DNS label')
    }
  }
  return canonical
}

function managedBlock(domain: string, identityHeader: string): string {
  return `${BEGIN_MARKER}\n- id: pangolin-connection\n  name: dsh-pangolin-auth\n  config:\n    publicOrigin: ${JSON.stringify(`https://${domain}`)}\n    identityHeader: ${JSON.stringify(identityHeader)}\n    recovery: {}\n    trustedHosts: !!js >-\n      [${JSON.stringify(domain)}, ...ctx.webRuntime.trustedHosts]\n    maxRequestBodyBytes: 314572800\n${END_MARKER}`
}

function parsePatch(source: string): unknown[] {
  const documents: unknown[] = []
  try {
    loadAll(source, document => documents.push(document), { schema: PATCH_SCHEMA })
  } catch (error) {
    throw new Error('pangolin-auth setup: cordis.patch.yml is not valid DSH YAML', { cause: error })
  }
  if (documents.length > 1) {
    throw new Error('pangolin-auth setup: cordis.patch.yml must contain one YAML document')
  }
  const document = documents[0]
  if (document === undefined || document === null) return []
  if (!Array.isArray(document)) {
    throw new Error('pangolin-auth setup: cordis.patch.yml root must be a patch array')
  }
  return document
}

function patchRowId(value: unknown): string | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const id = (value as Record<string, unknown>).id
  return typeof id === 'string' ? id : undefined
}

function hasYamlValue(source: string): boolean {
  return source.split('\n').some((line) => {
    const trimmed = line.trim()
    return trimmed !== '' && !trimmed.startsWith('#')
  })
}

function emptyPatchWithComments(source: string, eol: string): string | undefined {
  const lines = source.split(/\r?\n/u)
  const values = lines.filter((line) => {
    const trimmed = line.trim()
    return trimmed !== '' && !trimmed.startsWith('#')
  })
  if (values.length !== 1 || values[0]?.trim() !== '[]') return undefined
  return lines.filter(line => line.trim() !== '[]').join(eol).trimEnd()
}

function replaceManagedBlock(source: string, replacement: string | undefined): string {
  const rows = parsePatch(source)
  const begin = source.indexOf(BEGIN_MARKER)
  const end = source.indexOf(END_MARKER)
  if ((source.includes('# >>> dsh-pangolin-auth') && begin === -1)
    || (source.includes('# <<< dsh-pangolin-auth') && end === -1)) {
    throw new Error('pangolin-auth setup: cordis.patch.yml contains an unknown managed-section version')
  }
  if ((begin === -1) !== (end === -1) || (begin !== -1 && end < begin)) {
    throw new Error('pangolin-auth setup: cordis.patch.yml contains an incomplete managed section')
  }
  const ownedRows = rows.filter(row => patchRowId(row) === 'pangolin-connection')
  if ((begin === -1 && ownedRows.length !== 0) || (begin !== -1 && ownedRows.length !== 1)) {
    throw new Error('pangolin-auth setup: pangolin-connection is also targeted outside the managed section')
  }
  const eol = source.includes('\r\n') ? '\r\n' : '\n'
  const renderedReplacement = replacement?.replaceAll('\n', eol)
  let result: string
  if (begin === -1) {
    if (renderedReplacement === undefined) return source
    const comments = emptyPatchWithComments(source, eol)
    const prefix = (comments ?? source).trimEnd()
    result = `${prefix}${prefix === '' ? '' : `${eol}${eol}`}${renderedReplacement}${eol}`
  } else {
    if (source.indexOf(BEGIN_MARKER, begin + BEGIN_MARKER.length) !== -1
      || source.indexOf(END_MARKER, end + END_MARKER.length) !== -1) {
      throw new Error('pangolin-auth setup: cordis.patch.yml contains multiple managed sections')
    }
    const after = end + END_MARKER.length
    const prefix = source.slice(0, begin).trimEnd()
    const suffix = source.slice(after).trimStart()
    const sections = [prefix, renderedReplacement, suffix].filter(
      (section): section is string => section !== undefined && section !== '',
    )
    result = sections.length === 0 ? '' : `${sections.join(`${eol}${eol}`)}${eol}`
    if (renderedReplacement === undefined && !hasYamlValue(result)) {
      const comments = result.trimEnd()
      result = `${comments}${comments === '' ? '' : `${eol}${eol}`}[]${eol}`
    }
  }
  const updatedRows = parsePatch(result)
  const expectedOwnedRows = renderedReplacement === undefined ? 0 : 1
  if (updatedRows.filter(row => patchRowId(row) === 'pangolin-connection').length !== expectedOwnedRows) {
    throw new Error('pangolin-auth setup: generated patch did not preserve one owned connection row')
  }
  return result
}

function readManifest(value: string, path: string): ProfileManifest {
  const parsed: unknown = JSON.parse(value)
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error(`pangolin-auth setup: ${path} must contain a JSON object`)
  }
  return parsed as ProfileManifest
}

function profileBundles(manifest: ProfileManifest): string[] {
  const bundles = manifest.dsh?.profile?.bundles
  if (!Array.isArray(bundles) || !bundles.every(bundle => typeof bundle === 'string')) {
    throw new Error('pangolin-auth setup: profile package.json has no valid dsh.profile.bundles array')
  }
  return bundles
}

function assertInstalled(manifest: ProfileManifest): void {
  if (manifest.dependencies?.[PACKAGE_NAME] === undefined) {
    throw new Error(
      `pangolin-auth setup: ${PACKAGE_NAME} is not installed; run dsh plugin --profile <name> add <package> first`,
    )
  }
}

async function atomicWrite(path: string, content: string): Promise<void> {
  const existing = await lstat(path).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return undefined
    throw error
  })
  if (existing !== undefined && (!existing.isFile() || existing.isSymbolicLink())) {
    throw new Error(`pangolin-auth setup: refusing to replace non-regular file ${path}`)
  }
  const temp = join(dirname(path), `.${basename(path)}.${randomUUID()}.tmp`)
  await writeFile(temp, content, {
    encoding: 'utf8',
    mode: existing === undefined ? 0o644 : existing.mode & 0o777,
    flag: 'wx',
  })
  try {
    await rename(temp, path)
  } catch (error) {
    await rm(temp, { force: true })
    throw error
  }
}

async function backupProfile(
  profileDir: string,
  manifestText: string,
  patchText: string,
): Promise<string> {
  const backupDir = join(
    profileDir,
    '.dsh-pangolin-auth',
    'backups',
    `${new Date().toISOString().replaceAll(':', '-')}-${randomUUID()}`,
  )
  await mkdir(backupDir, { recursive: true, mode: 0o700 })
  await writeFile(join(backupDir, 'package.json'), manifestText, { encoding: 'utf8', mode: 0o600 })
  await writeFile(join(backupDir, 'cordis.patch.yml'), patchText, { encoding: 'utf8', mode: 0o600 })
  return backupDir
}

async function mutateProfile(
  profileDir: string,
  order: 'setup' | 'uninstall' | 'restore',
  update: (manifest: ProfileManifest, patch: string) => { manifest: ProfileManifest; patch: string },
): Promise<ProfileMutationResult> {
  const manifestPath = join(profileDir, 'package.json')
  const patchPath = join(profileDir, 'cordis.patch.yml')
  const lockPath = join(profileDir, '.dsh-pangolin-auth.lock')
  const lock = await open(lockPath, 'wx', 0o600).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'EEXIST') {
      throw new Error('pangolin-auth setup: another profile update is in progress')
    }
    throw error
  })
  try {
    const [manifestText, patchText] = await Promise.all([
      readFile(manifestPath, 'utf8'),
      readFile(patchPath, 'utf8').catch((error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT') return ''
        throw error
      }),
    ])
    const manifest = readManifest(manifestText, manifestPath)
    const updated = update(manifest, patchText)
    const updatedManifestText = `${JSON.stringify(updated.manifest, null, 2)}\n`
    const manifestChanged = updatedManifestText !== manifestText
    const patchChanged = updated.patch !== patchText
    if (!manifestChanged && !patchChanged) return { changed: false }
    const backupDir = await backupProfile(profileDir, manifestText, patchText)
    const steps = order === 'setup'
      ? [
          { changed: patchChanged, path: patchPath, next: updated.patch, previous: patchText },
          { changed: manifestChanged, path: manifestPath, next: updatedManifestText, previous: manifestText },
        ]
      : [
          { changed: manifestChanged, path: manifestPath, next: updatedManifestText, previous: manifestText },
          { changed: patchChanged, path: patchPath, next: updated.patch, previous: patchText },
        ]
    const committed: typeof steps = []
    try {
      for (const step of steps) {
        if (!step.changed) continue
        await atomicWrite(step.path, step.next)
        committed.push(step)
      }
    } catch (error) {
      for (const step of committed.reverse()) await atomicWrite(step.path, step.previous)
      throw error
    }
    return { changed: true, backupDir }
  } finally {
    await lock.close()
    await rm(lockPath, { force: true })
  }
}

/** Configure one profile to select the Pangolin bundle and its public domain. */
export async function setupProfile(options: SetupOptions): Promise<ProfileMutationResult> {
  const domain = resolveDomain(options.domain)
  const identityHeader = resolveIdentityHeader(options.identityHeader ?? 'remote-user')
  const profileDir = profileDirectory(options.dshHome, options.profile)
  await assertProfileDirectory(profileDir, options.profile)
  return mutateProfile(profileDir, 'setup', (manifest, patch) => {
    assertInstalled(manifest)
    const bundles = profileBundles(manifest)
    if (!bundles.includes('@deepseek-ai/dsh-web-app')) {
      throw new Error('pangolin-auth setup: selected profile is not a DSH Web profile')
    }
    const selected = [...bundles.filter(bundle => bundle !== PACKAGE_NAME), PACKAGE_NAME]
    return {
      manifest: {
        ...manifest,
        dsh: {
          ...manifest.dsh,
          profile: {
            ...manifest.dsh?.profile,
            bundles: selected,
          },
        },
      },
      patch: replaceManagedBlock(patch, managedBlock(domain, identityHeader)),
    }
  })
}

/** Remove only the managed patch section and Pangolin bundle selection. */
export async function uninstallProfile(options: UninstallOptions): Promise<ProfileMutationResult> {
  const profileDir = profileDirectory(options.dshHome, options.profile)
  await assertProfileDirectory(profileDir, options.profile)
  return mutateProfile(profileDir, 'uninstall', (manifest, patch) => {
    const bundles = profileBundles(manifest).filter(bundle => bundle !== PACKAGE_NAME)
    return {
      manifest: {
        ...manifest,
        dsh: {
          ...manifest.dsh,
          profile: {
            ...manifest.dsh?.profile,
            bundles,
          },
        },
      },
      patch: replaceManagedBlock(patch, undefined),
    }
  })
}

/** Restore exact profile files from one setup-created backup directory. */
export async function restoreProfileBackup(
  options: UninstallOptions & { backupDir: string },
): Promise<ProfileMutationResult> {
  const profileDir = profileDirectory(options.dshHome, options.profile)
  await assertProfileDirectory(profileDir, options.profile)
  const backupDir = resolve(options.backupDir)
  const expectedRoot = join(profileDir, '.dsh-pangolin-auth', 'backups')
  if (backupDir !== expectedRoot && !backupDir.startsWith(`${expectedRoot}/`)) {
    throw new Error('pangolin-auth setup: backup directory does not belong to this profile')
  }
  const [manifestText, patchText] = await Promise.all([
    readFile(join(backupDir, 'package.json'), 'utf8'),
    readFile(join(backupDir, 'cordis.patch.yml'), 'utf8'),
  ])
  return mutateProfile(profileDir, 'restore', () => ({
    manifest: readManifest(manifestText, join(backupDir, 'package.json')),
    patch: patchText,
  }))
}
