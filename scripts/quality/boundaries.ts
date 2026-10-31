import { parseSync } from 'oxc-parser'
import { readdir } from 'node:fs/promises'
import { builtinModules } from 'node:module'
import { dirname, relative, resolve, sep } from 'node:path'

// New packages must deliberately declare their direction here before use.
const policy: Record<string, { packages: readonly string[]; platform: boolean }> = {
  protocol: { packages: [], platform: false },
  runtime: { packages: ['protocol'], platform: true },
  core: { packages: ['protocol', 'runtime'], platform: false },
}

type Manifest = {
  name: string
  dependencies?: Record<string, string>
  exports?: string | Record<string, unknown>
}

type Package = { directory: string; manifest: Manifest }

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

function moduleName(specifier: string): string {
  return specifier.startsWith('@')
    ? specifier.split('/').slice(0, 2).join('/')
    : specifier.split('/')[0]!
}

function portable(path: string): string {
  return path.split(sep).join('/')
}

function inspectSource(
  filename: string,
  source: string,
  root: string,
  packages: ReadonlyMap<string, Package>
): { errors: string[]; imports: Set<string> } {
  const file = portable(relative(root, filename))
  const own = file.match(/^packages\/([^/]+)\/src\//)?.[1]
  const errors: string[] = []
  const imports = new Set<string>()
  if (!own) return { errors, imports }
  const rule = policy[own]
  const owner = [...packages.values()].find((pkg) => pkg.directory === own)
  if (!rule || !owner) return { errors: [`${file}: package has no boundary policy`], imports }

  const parsed = parseSync(filename, source, { sourceType: 'module' })
  if (parsed.errors.length)
    return {
      errors: parsed.errors.map((error) => `${file}: parse error: ${error.message}`),
      imports,
    }

  const inspect = (specifier: string) => {
    if (specifier.startsWith('.')) {
      const target = portable(
        relative(resolve(root, 'packages', own, 'src'), resolve(dirname(filename), specifier))
      )
      if (target === '..' || target.startsWith('../') || target.startsWith('/'))
        errors.push(`${file}: relative import escapes its public package: ${specifier}`)
      return
    }

    const builtin =
      specifier.startsWith('bun:') ||
      specifier === 'bun' ||
      builtinModules.includes(specifier.replace(/^node:/, ''))
    if (builtin) {
      if (!rule.platform)
        errors.push(`${file}: portable protocol imports platform module ${specifier}`)
      return
    }

    const name = moduleName(specifier)
    imports.add(name)
    const dependency = packages.get(name)
    if (!dependency || !rule.packages.includes(dependency.directory)) {
      errors.push(`${file}: forbidden package dependency ${specifier}`)
      return
    }
    if (!(name in (owner.manifest.dependencies ?? {})))
      errors.push(`${file}: undeclared dependency ${name}`)
    const subpath = specifier === name ? '.' : `.${specifier.slice(name.length)}`
    const exported = dependency.manifest.exports
    if (!exported || (typeof exported === 'string' ? subpath !== '.' : !(subpath in exported)))
      errors.push(`${file}: import bypasses public exports: ${specifier}`)
  }

  const sourceOf = (value: unknown) => {
    const node = record(value)
    if (typeof node?.['value'] === 'string') inspect(node['value'])
    else errors.push(`${file}: non-literal module load cannot be boundary-checked`)
  }

  const walk = (value: unknown): void => {
    if (Array.isArray(value)) {
      for (const child of value) walk(child)
      return
    }
    const node = record(value)
    if (!node) return
    const kind = node['type']
    if (
      (kind === 'ImportDeclaration' ||
        kind === 'ExportNamedDeclaration' ||
        kind === 'ExportAllDeclaration') &&
      node['source']
    )
      sourceOf(node['source'])
    if (kind === 'ImportExpression') sourceOf(node['source'])
    if (kind === 'TSImportType') sourceOf(node['source'] ?? node['argument'])
    if (kind === 'TSExternalModuleReference') sourceOf(node['expression'])
    const callee = record(node['callee'])
    if (
      kind === 'CallExpression' &&
      callee?.['type'] === 'Identifier' &&
      callee['name'] === 'require'
    ) {
      const args = node['arguments']
      sourceOf(Array.isArray(args) ? args[0] : undefined)
    }
    for (const child of Object.values(node)) if (child && typeof child === 'object') walk(child)
  }
  walk(parsed.program)
  return { errors, imports }
}

async function sourceFiles(directory: string): Promise<string[]> {
  const result: string[] = []
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = resolve(directory, entry.name)
    if (entry.isDirectory()) result.push(...(await sourceFiles(path)))
    else if (/\.[mc]?[jt]sx?$/.test(entry.name)) result.push(path)
  }
  return result.sort()
}

export async function checkBoundaries(root: string): Promise<string[]> {
  const packages = new Map<string, Package>()
  const errors: string[] = []
  for (const directory of await readdir(resolve(root, 'packages'), { withFileTypes: true })) {
    if (!directory.isDirectory()) continue
    const manifest: Manifest = await Bun.file(
      resolve(root, 'packages', directory.name, 'package.json')
    ).json()
    if (packages.has(manifest.name)) errors.push(`duplicate package name: ${manifest.name}`)
    packages.set(manifest.name, { directory: directory.name, manifest })
  }
  for (const [name, pkg] of packages) {
    const rule = policy[pkg.directory]
    if (!rule) {
      errors.push(`${name}: package has no boundary policy`)
      continue
    }
    const imports = new Set<string>()
    for (const filename of await sourceFiles(resolve(root, 'packages', pkg.directory, 'src'))) {
      const result = inspectSource(filename, await Bun.file(filename).text(), root, packages)
      errors.push(...result.errors)
      for (const dependency of result.imports) imports.add(dependency)
    }
    for (const dependency of Object.keys(pkg.manifest.dependencies ?? {})) {
      const target = packages.get(dependency)
      if (!target || !rule.packages.includes(target.directory))
        errors.push(`${name}: forbidden manifest dependency ${dependency}`)
      if (!imports.has(dependency)) errors.push(`${name}: unused runtime dependency ${dependency}`)
    }
  }
  return errors.sort()
}

if (import.meta.main) {
  const errors = await checkBoundaries(resolve(import.meta.dir, '../..'))
  if (errors.length) {
    console.error(errors.join('\n'))
    process.exitCode = 1
  } else console.log('Package boundaries and runtime dependency usage verified')
}
