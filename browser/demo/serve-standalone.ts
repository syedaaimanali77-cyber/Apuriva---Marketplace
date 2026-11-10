/**
 * Serves the build exactly as a hosted deployment does (Dockerfile): `node .next/standalone/server.js`, with
 * the two directories the standalone output does not copy itself (`.next/static`, `public`). `next start`
 * is NOT used: with `output: 'standalone'` Next warns that it "does not work", and it is not what production runs.
 *
 * Usage: tsx browser/demo/serve-standalone.ts [--copy-assets]
 */
import { spawn } from 'node:child_process';
import { cpSync, existsSync } from 'node:fs';
import path from 'node:path';

const root = path.join(__dirname, '..', '..');
const standalone = path.join(root, '.next', 'standalone');
if (!existsSync(path.join(standalone, 'server.js'))) throw new Error('serve-standalone: run `npm run build` first.');
if (process.argv.includes('--copy-assets')) {
  cpSync(path.join(root, '.next', 'static'), path.join(standalone, '.next', 'static'), { recursive: true });
  cpSync(path.join(root, 'public'), path.join(standalone, 'public'), { recursive: true });
}
const child = spawn(process.execPath, [path.join(standalone, 'server.js')], {
  cwd: standalone,
  env: { ...process.env, NODE_ENV: 'production', HOSTNAME: 'localhost' },
  stdio: 'inherit',
});
child.on('exit', (code) => process.exit(code ?? 1));
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => child.kill(signal));
