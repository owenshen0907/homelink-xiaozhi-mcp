import { readFileSync } from 'node:fs';

const metadata = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
export const packageName = metadata.name;
export const packageVersion = metadata.version;
