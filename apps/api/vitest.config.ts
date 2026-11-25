import swc from 'unplugin-swc';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [swc.vite({ jsc: { target: 'es2022', parser: { syntax: 'typescript', decorators: true }, transform: { legacyDecorator: true, decoratorMetadata: true } }, module: { type: 'es6' } })],
  test: {
    globalSetup: ['./test/global-setup.ts'],
    pool: 'forks',
    poolOptions: { forks: { singleFork: true } },
    testTimeout: 60_000,
    hookTimeout: 120_000,
    fileParallelism: false,
  },
});
