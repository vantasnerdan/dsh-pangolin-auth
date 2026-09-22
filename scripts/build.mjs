import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

const require = createRequire(import.meta.url)
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const lib = resolve(root, 'lib')

await rm(lib, { recursive: true, force: true })
await mkdir(lib, { recursive: true })

for (const entry of ['index', 'cli']) {
  await build({
    entryPoints: [resolve(root, `src/${entry}.ts`)],
    outfile: resolve(lib, `${entry}.js`),
    bundle: true,
    format: 'esm',
    platform: 'node',
    target: 'node22',
    packages: 'external',
    sourcemap: false,
    legalComments: 'none',
  })
}

const client = await build({
  entryPoints: [resolve(root, 'src/client/index.ts')],
  bundle: true,
  format: 'cjs',
  platform: 'browser',
  target: ['chrome120', 'firefox120', 'safari17'],
  write: false,
  sourcemap: false,
  legalComments: 'none',
  external: ['@deepseek-ai/cordis'],
})
const clientCode = client.outputFiles[0]?.text
if (clientCode === undefined) throw new Error('client build emitted no JavaScript')
await writeFile(resolve(lib, 'client.js'), `window.__ModuleLoader__.load({\n  id: "dsh-pangolin-auth",\n  factory: (require) => {\n    var module = { exports: {} };\n    var exports = module.exports;\n${clientCode}\n    return module.exports;\n  },\n});\n`)

const tsc = spawnSync(process.execPath, [
  require.resolve('typescript/bin/tsc'),
  '-p',
  resolve(root, 'tsconfig.json'),
], { cwd: root, stdio: 'inherit' })
if (tsc.status !== 0) process.exit(tsc.status ?? 1)
