/**
 * Sanitize all raw font name strings in public/ files,
 * replacing them with the correct CSS variable references.
 * Run: node scripts/clean_fonts.js
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const files = [
  path.resolve(__dirname, '../public/index.html'),
  path.resolve(__dirname, '../public/terminal-components.css'),
  path.resolve(__dirname, '../public/app.js'),
];

for (const file of files) {
  let content = fs.readFileSync(file, 'utf8');

  // Fix nested variables caused by previous script
  content = content.replace(/var\(--font-primary,\s*var\(--font-primary,\s*"Outfit",\s*sans-serif\)\)/g, 'var(--font-primary)');
  content = content.replace(/var\(--font-secondary,\s*var\(--font-secondary,\s*"Plus Jakarta Sans",\s*sans-serif\)\)/g, 'var(--font-secondary)');
  content = content.replace(/var\(--font-primary,\s*"Outfit",\s*sans-serif\)/g, 'var(--font-primary)');
  content = content.replace(/var\(--font-secondary,\s*"Plus Jakarta Sans",\s*sans-serif\)/g, 'var(--font-secondary)');

  // Fix any remaining raw font names for primary
  content = content.replace(/['"]Outfit['"]\s*,\s*sans-serif/g, 'var(--font-primary)');
  content = content.replace(/['"]Outfit['"]\s*,\s*var\(--font-secondary\)/g, 'var(--font-primary)');
  content = content.replace(/['"]Outfit['"]\s*,\s*monospace/g, 'var(--font-primary)');
  content = content.replace(/font-family:\s*['"]Outfit['"]/g, 'font-family: var(--font-primary)');
  content = content.replace(/font-family:\s*\\"Outfit\\"/g, 'font-family: var(--font-primary)');

  // Fix any remaining raw font names for secondary
  content = content.replace(/['"]Plus Jakarta Sans['"]\s*,\s*system-ui\s*,\s*sans-serif/g, 'var(--font-secondary)');
  content = content.replace(/['"]Plus Jakarta Sans['"]\s*,\s*sans-serif/g, 'var(--font-secondary)');
  content = content.replace(/['"]Plus Jakarta Sans['"]\s*,\s*monospace\s*,\s*sans-serif/g, 'var(--font-secondary)');
  content = content.replace(/font-family:\s*['"]Plus Jakarta Sans['"]/g, 'font-family: var(--font-secondary)');
  content = content.replace(/font-family:\s*\\"Plus Jakarta Sans\\"/g, 'font-family: var(--font-secondary)');

  // Fix rogue Inter
  content = content.replace(/font-family:\s*['"]Inter['"]\s*,\s*system-ui\s*,\s*sans-serif/g, 'font-family: var(--font-secondary)');
  content = content.replace(/font-family:\s*['"]Inter['"]\s*,\s*sans-serif/g, 'font-family: var(--font-secondary)');
  content = content.replace(/font-family:\s*\\"Inter\\"/g, 'font-family: var(--font-secondary)');

  fs.writeFileSync(file, content);
}

console.log('Fonts fully sanitized.');
