import { defineConfig } from 'tsdown'

export default defineConfig([{
  entry: {
    index: 'lib/types/index.js',
    adapters: 'lib/types/adapters.js',
    cli: 'lib/types/cli.js',
    remote: 'lib/types/remote.js',
    typert: 'lib/types/typert.js',
  },
  outDir: 'lib',
  format: ['esm'],
  platform: 'node',
  target: 'es2024',
  fixedExtension: false,
  dts: false,
  clean: false,
  deps: { onlyBundle: [] },
}, {
  name: '@deepseek-ai/dsh-shuttle/client',
  entry: { client: 'src/client/index.ts' },
  outDir: 'lib',
  format: 'cjs',
  platform: 'browser',
  target: 'es2022',
  dts: false,
  sourcemap: true,
  clean: false,
  deps: { alwaysBundle: ['zod'], onlyBundle: ['zod'], neverBundle: ['react', 'react/jsx-runtime'] },
  outputOptions: {
    entryFileNames: 'client.js',
    banner: 'window.__ModuleLoader__.load({ id: "@deepseek-ai/dsh-shuttle", factory: (require) => {',
    footer: 'return module.exports; } });',
    intro: 'var module = { exports: {} }; var exports = module.exports;',
  },
}])
