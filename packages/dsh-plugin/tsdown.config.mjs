import { externalClientBundle } from './scripts/external-client-bundle.mjs'

export default externalClientBundle('boss-watch-dsh-plugin', ['src/index.ts'], {
  lib: {
    target: 'es2022',
    clean: true,
    deps: { neverBundle: [/^@deepseek-ai\//] },
    outputOptions: { entryFileNames: 'index.js' },
  },
})
