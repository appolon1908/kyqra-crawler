import fs from 'node:fs';

const source = new URL('../src/api/static/', import.meta.url);
const destination = new URL('../dist/api/static/', import.meta.url);

fs.mkdirSync(destination, { recursive: true });
fs.cpSync(source, destination, { recursive: true });
