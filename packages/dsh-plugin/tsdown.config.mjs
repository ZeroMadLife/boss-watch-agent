import { clientBundle } from '../../../deepseek-harness/packages/client/tsdown.client.ts'

export default clientBundle('boss-watch-dsh-plugin', ['src/index.ts'], {
  lib: {
    target: 'es2022',
    clean: true,
    deps: { neverBundle: [/^@deepseek-ai\//] },
    outputOptions: { entryFileNames: 'index.js' },
  },
})
