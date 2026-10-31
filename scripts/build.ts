import { resolve } from 'node:path'

// Package validation build only. Production AOT is a separate, explicit command.
const result = await Bun.build({
  entrypoints: [
    resolve(import.meta.dir, '../packages/protocol/src/index.ts'),
    resolve(import.meta.dir, '../packages/runtime/src/index.ts'),
    resolve(import.meta.dir, '../packages/core/src/index.ts'),
  ],
  outdir: resolve(import.meta.dir, '../dist'),
  target: 'bun',
  format: 'esm',
  sourcemap: 'external',
})

if (!result.success) throw new AggregateError(result.logs, 'TypeScript package build failed')
console.log(
  'Built protocol, runtime and public core packages (JavaScript modules; not an AOT executable)'
)
