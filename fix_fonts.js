import fs from 'fs';
import path from 'path';

const files = [
  path.resolve('./public/index.html'),
  path.resolve('./public/styles-v2.css')
];

for (const file of files) {
  let content = fs.readFileSync(file, 'utf8');
  
  // Replace 'Outfit' variations
  content = content.replace(/'Outfit',\s*sans-serif/g, 'var(--font-primary, "Outfit", sans-serif)');
  content = content.replace(/"Outfit",\s*sans-serif/g, 'var(--font-primary, "Outfit", sans-serif)');
  content = content.replace(/'Outfit',\s*sans-serif\s*!important/g, 'var(--font-primary, "Outfit", sans-serif) !important');
  content = content.replace(/"Outfit",\s*sans-serif\s*!important/g, 'var(--font-primary, "Outfit", sans-serif) !important');
  
  // Replace 'Plus Jakarta Sans' variations
  content = content.replace(/'Plus Jakarta Sans',\s*system-ui,\s*sans-serif/g, 'var(--font-secondary, "Plus Jakarta Sans", sans-serif)');
  content = content.replace(/"Plus Jakarta Sans",\s*system-ui,\s*sans-serif/g, 'var(--font-secondary, "Plus Jakarta Sans", sans-serif)');
  content = content.replace(/'Plus Jakarta Sans',\s*sans-serif/g, 'var(--font-secondary, "Plus Jakarta Sans", sans-serif)');
  content = content.replace(/"Plus Jakarta Sans",\s*sans-serif/g, 'var(--font-secondary, "Plus Jakarta Sans", sans-serif)');
  
  fs.writeFileSync(file, content);
}

console.log('Fonts replaced with CSS variables.');
