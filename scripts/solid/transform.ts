import { transformSync } from '@babel/core'
import solid from 'babel-preset-solid'

/** Official Solid universal transform; project/Babel configuration cannot select DOM output. */
export function transformSolid(source: string, filename: string): string {
  const result = transformSync(source, {
    filename,
    babelrc: false,
    configFile: false,
    sourceMaps: false,
    parserOpts: { plugins: ['typescript', 'jsx'] },
    presets: [[solid, { generate: 'universal', moduleName: '@bun-native/solid', dev: false }]],
  })
  if (!result?.code) throw new Error('Solid JSX transform produced no application code')
  return result.code
}
