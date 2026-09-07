import fs from 'node:fs';

const readStatic = (filename: string): string =>
  fs.readFileSync(new URL(`./static/${filename}`, import.meta.url), 'utf8');

export const dashboardHtml = (): string =>
  readStatic('dashboard.html')
    .replace('__KYQRA_STYLE__', readStatic('dashboard.css'))
    .replace('__KYQRA_SCRIPT__', readStatic('dashboard.js'));
