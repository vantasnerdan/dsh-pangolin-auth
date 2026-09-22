import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  resolveDomain,
  restoreProfileBackup,
  setupProfile,
  uninstallProfile,
} from '../src/setup.ts'

const EMPTY_PATCH = '# User profile patch.\n# Keep unrelated entries here.\n[]\n'

async function fixture(patch = EMPTY_PATCH): Promise<{ home: string; profileDir: string }> {
  const home = await mkdtemp(join(tmpdir(), 'dsh-pangolin-auth-'))
  const profileDir = join(home, 'profiles', 'web')
  await mkdir(profileDir, { recursive: true })
  await writeFile(join(profileDir, 'package.json'), `${JSON.stringify({
    name: 'dsh-profile-web',
    private: true,
    dependencies: {
      'unrelated-plugin': '1.0.0',
      'dsh-pangolin-auth': 'file:plugin.tgz',
    },
    dsh: {
      profile: {
        bundles: [
          '@deepseek-ai/dsh-base',
          'dsh-pangolin-auth',
          '@deepseek-ai/dsh-web-app',
          'unrelated-plugin',
          'dsh-pangolin-auth',
        ],
        patchReload: 'live',
      },
    },
  }, null, 2)}\n`)
  await writeFile(join(profileDir, 'cordis.patch.yml'), patch)
  return { home, profileDir }
}

async function files(profileDir: string): Promise<{ manifest: string; patch: string }> {
  return {
    manifest: await readFile(join(profileDir, 'package.json'), 'utf8'),
    patch: await readFile(join(profileDir, 'cordis.patch.yml'), 'utf8'),
  }
}

describe('profile setup', () => {
  it('replaces the canonical empty patch, deduplicates the bundle, and is idempotent', async () => {
    const { home, profileDir } = await fixture()
    const first = await setupProfile({ dshHome: home, profile: 'web', domain: 'agent-one.example.com' })
    expect(first.changed).toBe(true)
    expect(first.backupDir).toContain('.dsh-pangolin-auth/backups')

    const configured = await files(profileDir)
    expect(configured.patch).toContain('# User profile patch.')
    expect(configured.patch).not.toMatch(/^\[\]$/mu)
    expect(configured.patch).toContain('publicOrigin: "https://agent-one.example.com"')
    expect(configured.patch).toContain('["agent-one.example.com", ...ctx.webRuntime.trustedHosts]')
    expect(configured.patch.match(/id: pangolin-connection/gu)).toHaveLength(1)
    const manifest = JSON.parse(configured.manifest) as { dsh: { profile: { bundles: string[] } } }
    expect(manifest.dsh.profile.bundles.at(-1)).toBe('dsh-pangolin-auth')
    expect(manifest.dsh.profile.bundles.filter(value => value === 'dsh-pangolin-auth')).toHaveLength(1)

    expect((await setupProfile({
      dshHome: home,
      profile: 'web',
      domain: 'agent-one.example.com',
    })).changed).toBe(false)
    expect(await files(profileDir)).toEqual(configured)
  })

  it('updates one managed block for a second domain and removes only managed state', async () => {
    const unrelated = '- id: memory-rsi\n  config:\n    enabled: true\n'
    const { home, profileDir } = await fixture(unrelated)
    await setupProfile({ dshHome: home, profile: 'web', domain: 'agent-one.example.com' })
    await setupProfile({ dshHome: home, profile: 'web', domain: 'agent-two.example.com:8443' })
    const changed = await files(profileDir)
    expect(changed.patch).not.toContain('agent-one.example.com')
    expect(changed.patch).toContain('https://agent-two.example.com:8443')
    expect(changed.patch.match(/managed setup v1; do not edit/gu)).toHaveLength(1)
    expect(changed.patch).toContain('id: memory-rsi')

    const removed = await uninstallProfile({ dshHome: home, profile: 'web' })
    expect(removed.changed).toBe(true)
    const uninstalled = await files(profileDir)
    expect(uninstalled.patch).toBe(unrelated)
    expect(uninstalled.patch).not.toContain('pangolin-connection')
    const manifest = JSON.parse(uninstalled.manifest) as { dependencies: Record<string, string>; dsh: { profile: { bundles: string[] } } }
    expect(manifest.dependencies['dsh-pangolin-auth']).toBe('file:plugin.tgz')
    expect(manifest.dsh.profile.bundles).not.toContain('dsh-pangolin-auth')
  })

  it('restores the canonical empty sequence when the managed block was the only entry', async () => {
    const { home, profileDir } = await fixture()
    await setupProfile({ dshHome: home, profile: 'web', domain: 'agent.example.com' })
    await uninstallProfile({ dshHome: home, profile: 'web' })
    const patch = (await files(profileDir)).patch
    expect(patch).toContain('# User profile patch.')
    expect(patch).toMatch(/^\[\]$/mu)
    expect(patch).not.toContain('pangolin-connection')
  })

  it('creates exact backups that can be explicitly restored', async () => {
    const { home, profileDir } = await fixture()
    const original = await files(profileDir)
    const result = await setupProfile({ dshHome: home, profile: 'web', domain: 'agent.example.com' })
    expect(result.backupDir).toBeDefined()
    await restoreProfileBackup({
      dshHome: home,
      profile: 'web',
      backupDir: result.backupDir ?? '',
    })
    expect(await files(profileDir)).toEqual(original)
  })

  it('fails closed on malformed markers and unmanaged ownership', async () => {
    for (const patch of [
      '# >>> dsh-pangolin-auth managed setup v1; do not edit\n',
      '- id: pangolin-connection\n  config: {}\n',
      'not-an-array: true\n',
    ]) {
      const { home, profileDir } = await fixture(patch)
      const before = await files(profileDir)
      await expect(setupProfile({
        dshHome: home,
        profile: 'web',
        domain: 'agent.example.com',
      })).rejects.toThrow()
      expect(await files(profileDir)).toEqual(before)
    }
  })
})

describe('domain validation', () => {
  it('accepts canonical authorities and rejects URL syntax or rewrites', () => {
    expect(resolveDomain('Agent.Example.com:8443')).toBe('agent.example.com:8443')
    expect(resolveDomain('[::1]:8443')).toBe('[::1]:8443')
    for (const value of [
      'https://agent.example.com',
      'agent.example.com/path',
      ' agent.example.com',
      'agent.example.com:0080',
      '0x7f.0.0.1',
      '*.example.com',
      'agent_name.example.com',
      'agent.example.com.',
      'agent.example.com:0',
      'éxample.com',
      'agent.example.com:443',
    ]) {
      expect(() => resolveDomain(value)).toThrow()
    }
  })
})
