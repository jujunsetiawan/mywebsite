// Minimal project used by tests/unit/content-build.test.ts to prove that an
// invalid content entry fails `astro build`.
import { defineConfig } from 'astro/config';

export default defineConfig({ output: 'static', logLevel: 'error' });
