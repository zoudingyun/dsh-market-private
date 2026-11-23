/**
 * Publishing a locally installed plugin back to a private market.
 *
 * dsh-market can install from any registry but has never been able to send
 * anything the other way: a plugin author had to leave the app, run
 * `npm publish`, and then hope the market's index picked it up. This module
 * closes that loop — list what is installed here, pack one, POST it to the
 * market's release endpoint with the user's token.
 *
 * Two rules shape the code:
 *
 *  1. **Pack, don't copy.** A published artifact has to be what `npm pack`
 *     would produce (respecting `files`, `.npmignore`, the `prepack` hook), or
 *     the thing users install differs from the thing the author tested.
 *  2. **`link:` first.** A development install is a symlink; packing the link
 *     itself produces a tarball containing nothing. The symlink is resolved to
 *     its real source directory before packing.
 */

import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { winCmdShim, cmdCommandLine, toolSearchDirs } from './dsh-cli.ts'
import { marketOrigin, accountFor, forgetAccount } from './accounts.ts'
import { profileDir, readInstalled, readInstalledManifest } from './profile.ts'

/** One installed package that declares a DSH surface and can be packed. */
export interface LocalBundle {
  name: string
  version: string
  /** Title from the package's own `locale/zh.json` (or `en`), when it has one. */
  title?: string
  description?: string
  /** Absolute, symlink-resolved source directory. */
  dir: string
  /** True when the install is a `link:` — a development checkout. */
  linked: boolean
  /** True when the manifest declares `dsh.bundle`, i.e. the market would list it. */
  bundle: boolean
  /** Declared `engines.dsh`, for the "will this ever install" question. */
  enginesDsh?: string
}

/** Windows `.cmd` shims need cmd.exe; POSIX starts the binary directly. */
function spawnTool(file: string, args: readonly string[], cwd: string, env: NodeJS.ProcessEnv) {
  if (process.platform === 'win32') {
    return spawn(process.env.ComSpec ?? 'cmd.exe', ['/d', '/s', '/c', `"${cmdCommandLine([file, ...args])}"`], {
      cwd, env, windowsHide: true, windowsVerbatimArguments: true, stdio: ['ignore', 'pipe', 'pipe'],
    })
  }
  return spawn(file, [...args], { cwd, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
}

function pathWithTools(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const separator = process.platform === 'win32' ? ';' : ':'
  const parts = [...toolSearchDirs(), ...(env.PATH ?? env.Path ?? '').split(separator)].filter(part => part.trim() !== '')
  return { ...env, PATH: parts.join(separator), ...(process.platform === 'win32' ? { Path: parts.join(separator) } : {}) }
}

interface PackedArtifact {
  file: string
  name: string
  version: string
  bytes: number
}

/**
 * `npm pack`, falling back to `pnpm pack`.
 *
 * Both write the same tarball; the difference is only which tool a dev box
 * happens to have. `--json` on npm keeps the filename machine-readable instead
 * of scraping the last line of stdout.
 */
async function pack(dir: string, outDir: string, timeoutMs = 120_000): Promise<PackedArtifact> {
  const env = pathWithTools(process.env)
  const attempts: { file: string; args: string[] }[] = winCmdShim
    ? [{ file: 'npm.cmd', args: [] }, { file: 'pnpm.cmd', args: [] }]
    : [{ file: 'npm', args: [] }, { file: 'pnpm', args: [] }]

  let lastError: Error = new Error('no pack tool')
  for (const attempt of attempts) {
    const args = [...attempt.args, 'pack', '--pack-destination', outDir, '--json']
    try {
      const output = await new Promise<string>((resolve, reject) => {
        const child = spawnTool(attempt.file, args, dir, env)
        let stdout = ''
        let stderr = ''
        const timer = setTimeout(() => {
          child.kill()
          reject(new Error(`${attempt.file} pack timed out after ${String(timeoutMs)}ms`))
        }, timeoutMs)
        child.stdout?.on('data', (chunk: Buffer) => { stdout += chunk.toString('utf8') })
        child.stderr?.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf8') })
        child.on('error', (error) => { clearTimeout(timer); reject(error) })
        child.on('close', (code) => {
          clearTimeout(timer)
          if (code === 0) resolve(stdout)
          else reject(new Error(`${attempt.file} pack failed (${String(code)}): ${stderr.trim().split('\n').slice(-3).join(' ')}`))
        })
      })
      // npm --json prints an array; pnpm --json prints an object. Accept both.
      const start = output.indexOf('[') === -1 ? output.indexOf('{') : output.indexOf('[')
      if (start === -1) throw new Error(`${attempt.file} pack printed no JSON`)
      const parsed = JSON.parse(output.slice(start)) as unknown
      const record = (Array.isArray(parsed) ? parsed[0] : parsed) as { filename?: unknown; name?: unknown; version?: unknown; size?: unknown }
      const filename = typeof record.filename === 'string' ? record.filename : ''
      const file = existsSync(join(outDir, filename)) ? join(outDir, filename) : join(outDir, basename(filename))
      if (!existsSync(file)) throw new Error(`${attempt.file} pack reported ${filename}, which is not on disk`)
      return {
        file,
        name: typeof record.name === 'string' ? record.name : basename(dir),
        version: typeof record.version === 'string' ? record.version : '0.0.0',
        bytes: statSync(file).size,
      }
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error))
    }
  }
  throw lastError
}

/** Title/description from a package's own locale files, the same place the market reads them. */
function localeMeta(dir: string): { title?: string; description?: string } {
  for (const name of ['zh.json', 'en.json']) {
    const file = join(dir, 'locale', name)
    if (!existsSync(file)) continue
    try {
      const doc = JSON.parse(readFileSync(file, 'utf8')) as { meta?: { title?: unknown; description?: unknown } }
      const title = typeof doc.meta?.title === 'string' ? doc.meta.title : undefined
      const description = typeof doc.meta?.description === 'string' ? doc.meta.description : undefined
      if (title !== undefined || description !== undefined) {
        return { ...(title === undefined ? {} : { title }), ...(description === undefined ? {} : { description }) }
      }
    } catch { /* a broken locale file is not a reason to hide the plugin */ }
  }
  return {}
}

/**
 * Everything installed in this profile that could be published.
 *
 * Only packages with a DSH surface are listed: the rest are libraries the
 * plugin page never shows either, and publishing one would put a dependency on
 * the market shelf as if it were a plugin.
 */
export function listLocalBundles(profile: string, explicitDir?: string): LocalBundle[] {
  const root = profileDir(profile, explicitDir)
  const installed = readInstalled(profile, explicitDir)
  const out: LocalBundle[] = []
  for (const name of Object.keys(installed).sort()) {
    const manifest = readInstalledManifest(profile, name, explicitDir) as
      | { version?: unknown; description?: unknown; dsh?: { bundle?: unknown }; engines?: { dsh?: unknown } }
      | null
    if (manifest === null || typeof manifest !== 'object') continue
    if (manifest.dsh === undefined || manifest.dsh === null) continue
    const entry = join(root, 'node_modules', name)
    let dir: string
    try {
      dir = realpathSync(entry)
    } catch {
      continue
    }
    if (!existsSync(join(dir, 'package.json'))) continue
    const meta = localeMeta(dir)
    out.push({
      name,
      version: typeof manifest.version === 'string' ? manifest.version : (installed[name] ?? ''),
      ...(meta.title === undefined ? {} : { title: meta.title }),
      ...(meta.description === undefined
        ? (typeof manifest.description === 'string' ? { description: manifest.description } : {})
        : { description: meta.description }),
      dir,
      linked: dir !== entry,
      bundle: manifest.dsh?.bundle !== undefined && manifest.dsh?.bundle !== null,
      ...(typeof manifest.engines?.dsh === 'string' ? { enginesDsh: manifest.engines.dsh } : {}),
    })
  }
  return out
}

export interface PublishRequest {
  server: string
  /** Package name as installed here. */
  name: string
  category?: string
  labels?: string[]
  profile: string
  profileDirectory?: string
  signal?: AbortSignal
}

export interface PublishResult {
  server: string
  name: string
  version: string
  bytes: number
  /** Whatever the market said: 'pending' when it reviews before listing. */
  status: string
  releaseId?: string
}

/**
 * Pack one installed bundle and hand it to the market.
 *
 * The market stores it as a *release*, not as a listed plugin: depending on
 * its policy that means an admin still has to approve it. Saying "pending" in
 * the UI is not pessimism, it is the contract.
 */
export async function publishBundle(request: PublishRequest): Promise<PublishResult> {
  const origin = marketOrigin(request.server)
  if (origin === null) throw new PublishError('bad-server', '市场地址不对 / invalid market address')
  const account = accountFor(origin)
  if (account === null) throw new PublishError('unauthenticated', '先登录这个市场 / log in to this market first')

  const bundle = listLocalBundles(request.profile, request.profileDirectory).find(item => item.name === request.name)
  if (bundle === undefined) throw new PublishError('not-installed', `本机没有装着 ${request.name} / ${request.name} is not installed here`)
  if (!bundle.bundle) throw new PublishError('not-a-bundle', `${request.name} 没有声明 dsh.bundle，市场不会收 / it declares no dsh.bundle`)

  const workDir = mkdtempSync(join(tmpdir(), 'dsh-market-pack-'))
  try {
    const artifact = await pack(bundle.dir, workDir)
    const body = readFileSync(artifact.file)
    const query = new URLSearchParams()
    if (request.category !== undefined && request.category !== '') query.set('category', request.category)
    if (request.labels !== undefined && request.labels.length > 0) query.set('labels', request.labels.join(','))
    const url = `${origin}/api/v1/releases${query.size === 0 ? '' : `?${query.toString()}`}`

    let response: Response
    try {
      response = await fetch(url, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${account.token}`,
          'content-type': 'application/octet-stream',
          accept: 'application/json',
        },
        body,
        ...(request.signal === undefined ? {} : { signal: request.signal }),
      })
    } catch (error) {
      throw new PublishError('network', `上传失败 / upload failed: ${error instanceof Error ? error.message : String(error)}`)
    }
    const text = await response.text()
    let doc: Record<string, unknown> = {}
    try {
      doc = JSON.parse(text) as Record<string, unknown>
    } catch { /* the market refused with a plain body; handled below */ }
    if (!response.ok) {
      // The market refuses with the reasons it refused: a packing rule, a
      // missing `engines.dsh`, a version that already exists. Showing "refused"
      // alone would leave the author with nothing to fix.
      const reasons = Array.isArray(doc.detail)
        ? (doc.detail as { level?: unknown; message?: unknown }[])
          .filter(item => item.level === 'error' || item.level === undefined)
          .map(item => (typeof item.message === 'string' ? item.message : ''))
          .filter(message => message !== '')
          .slice(0, 3)
        : []
      const base = typeof doc.error === 'string' ? doc.error : `HTTP ${String(response.status)}`
      const detail = reasons.length === 0 ? base : `${base}：${reasons.join('；')}`
      // 401 means the token this profile holds is dead (revoked elsewhere,
      // password changed, server restored). Forget it so the gate offers a
      // login instead of the same error next time.
      if (response.status === 401) forgetAccount(origin)
      throw new PublishError(response.status === 401 ? 'unauthenticated' : 'refused', detail)
    }
    return {
      server: origin,
      name: typeof doc.name === 'string' ? doc.name : artifact.name,
      version: typeof doc.version === 'string' ? doc.version : artifact.version,
      bytes: body.length,
      status: typeof doc.status === 'string' ? doc.status : 'pending',
      ...(typeof doc.id === 'string' ? { releaseId: doc.id } : {}),
    }
  } finally {
    // The tarball is uploaded; a copy on disk helps nobody and grows forever.
    rmSync(workDir, { recursive: true, force: true })
  }
}

export class PublishError extends Error {
  constructor(
    readonly code: 'bad-server' | 'unauthenticated' | 'not-installed' | 'not-a-bundle' | 'network' | 'refused',
    message: string,
  ) {
    super(message)
    this.name = 'PublishError'
  }
}

/** Exported for the route: the pack step is the slow one, so it reports progress. */
export const PACK_STEPS = ['packing', 'uploading'] as const
export type PackStep = typeof PACK_STEPS[number]
