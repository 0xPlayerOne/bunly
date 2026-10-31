import { mkdir, realpath, stat } from 'node:fs/promises'
import { isAbsolute, resolve } from 'node:path'
import { transformSolid } from './solid/transform.ts'

/** Build-time JSX conversion only; the generated module is shared by dev and AOT. */
export async function buildSolid(entry: string, outdir: string): Promise<string> {
  const source = await realpath(entry)
  if (!(await stat(source)).isFile() || !/\.[jt]sx?$/.test(source))
    throw new Error('Solid entry must be a TypeScript/JavaScript source file')
  const destination = resolve(outdir)
  await mkdir(destination, { recursive: true })
  const result = await Bun.build({
    entrypoints: [source],
    outdir: destination,
    naming: 'application.js',
    target: 'bun',
    format: 'esm',
    conditions: ['browser'],
    sourcemap: 'external',
    plugins: [
      {
        name: 'solid-native-universal',
        setup(build) {
          build.onLoad({ filter: /\.[jt]sx$/ }, async ({ path }) => ({
            contents: transformSolid(await Bun.file(path).text(), path),
            loader: 'ts',
          }))
        },
      },
    ],
  })
  if (!result.success) throw new AggregateError(result.logs, 'Solid native build failed')
  return resolve(destination, 'application.js')
}

if (import.meta.main) {
  const entry = process.argv[2]
  const outdir = process.argv[3]
  if (!entry || !outdir || process.argv.length !== 4 || !isAbsolute(outdir))
    throw new Error('Usage: bun scripts/solid-build.ts ENTRY ABSOLUTE_OUTPUT_DIRECTORY')
  console.log(await buildSolid(entry, outdir))
}
