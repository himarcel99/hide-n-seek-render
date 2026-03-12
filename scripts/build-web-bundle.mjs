import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, '..');
const publicDir = path.join(projectRoot, 'public');
const vendorDir = path.join(publicDir, 'vendor');

mkdirSync(vendorDir, { recursive: true });

cpSync(
    path.join(projectRoot, 'node_modules', 'socket.io-client', 'dist', 'socket.io.min.js'),
    path.join(vendorDir, 'socket.io.min.js')
);
cpSync(
    path.join(projectRoot, 'node_modules', 'tone', 'build', 'Tone.js'),
    path.join(vendorDir, 'tone.js')
);

const tailwindBin = path.join(
    projectRoot,
    'node_modules',
    '.bin',
    process.platform === 'win32' ? 'tailwindcss.cmd' : 'tailwindcss'
);

execFileSync(
    tailwindBin,
    [
        '--input',
        path.join(publicDir, 'styles.input.css'),
        '--output',
        path.join(publicDir, 'styles.css'),
        '--content',
        path.join(publicDir, 'index.html'),
        path.join(publicDir, 'client.js'),
        '--minify'
    ],
    {
        stdio: 'inherit'
    }
);
