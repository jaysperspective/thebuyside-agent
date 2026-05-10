import { copyFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';

const distRegistry = 'dist/registry';
await mkdir(distRegistry, { recursive: true });
await Promise.all([
  copyFile('src/registry/seed.json', join(distRegistry, 'seed.json')),
  copyFile('src/registry/seed.candidates.json', join(distRegistry, 'seed.candidates.json')),
]);
console.log('copied registry assets ->', distRegistry);
