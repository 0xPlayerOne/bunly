import { plugin } from 'bun'
import { fileURLToPath } from 'node:url'

// Runtime plugins receive the resolved package path. Replace only Solid's server
// export with its exact, installed reactive source; other packages keep Node resolution.
const reactive = await Bun.file(fileURLToPath(import.meta.resolve('solid-js/dist/solid.js'))).text()
await plugin({
  name: 'solid-native-test-runtime',
  setup(build) {
    build.onLoad({ filter: /[\\/]solid-js[\\/]dist[\\/]server\.js$/ }, () => ({
      contents: reactive,
      loader: 'js',
    }))
  },
})
