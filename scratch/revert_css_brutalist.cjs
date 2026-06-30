const fs = require('fs');
let css = fs.readFileSync('public/styles.css', 'utf8');

// 1. Revert typography back to monospace
css = css.replace(/font-family:\s*"Outfit",\s*system-ui,\s*-apple-system,\s*sans-serif;/g, 'font-family: "JetBrains Mono", monospace;');
css = css.replace(/font-family:\s*"Outfit",\s*sans-serif;/g, 'font-family: "JetBrains Mono", monospace;');
css = css.replace(/font-family:\s*'Outfit',\s*sans-serif;/g, 'font-family: "JetBrains Mono", monospace;');

// 2. Revert colors back to Deep Black
css = css.replace(/--bg-base:\s*#070709;/g, '--bg-base: #000000;');
css = css.replace(/--bg-base:\s*#09090b;/g, '--bg-base: #000000;');
css = css.replace(/--bg-surface:\s*#0f0f12;/g, '--bg-surface: #0a0a0a;');
css = css.replace(/--bg-surface:\s*#18181b;/g, '--bg-surface: #0a0a0a;');
css = css.replace(/--bg-elevated:\s*#18181d;/g, '--bg-elevated: #111111;');
css = css.replace(/--bg-elevated:\s*#27272a;/g, '--bg-elevated: #111111;');
css = css.replace(/--bg-overlay:\s*#222228;/g, '--bg-overlay: #1a1a1a;');

// 3. Revert radii back to 0px
css = css.replace(/--radius-xs:\s*4px;/g, '--radius-xs: 0px;');
css = css.replace(/--radius-sm:\s*6px;/g, '--radius-sm: 0px;');
css = css.replace(/--radius-md:\s*8px;/g, '--radius-md: 0px;');
css = css.replace(/--radius-lg:\s*10px;/g, '--radius-lg: 0px;');
css = css.replace(/--radius-lg:\s*12px;/g, '--radius-lg: 0px;');
css = css.replace(/--radius-xl:\s*12px;/g, '--radius-xl: 0px;');
css = css.replace(/--radius-xl:\s*16px;/g, '--radius-xl: 0px;');
css = css.replace(/--radius-full:\s*9999px;/g, '--radius-full: 0px;');
css = css.replace(/border-radius:\s*var\(--radius-md\);/g, 'border-radius: 0px;');
css = css.replace(/border-radius:\s*var\(--radius-lg\);/g, 'border-radius: 0px;');

// 4. Revert soft shadows back to none
css = css.replace(/--shadow-sm:\s*0 1px 2px rgba\(0,0,0,0.5\), 0 1px 3px rgba\(0,0,0,0.4\);/g, '--shadow-sm: none;');
css = css.replace(/--shadow-md:\s*0 4px 8px -2px rgba\(0,0,0,0.6\), 0 2px 4px -1px rgba\(0,0,0,0.4\);/g, '--shadow-md: none;');
css = css.replace(/--shadow-lg:\s*0 12px 20px -4px rgba\(0,0,0,0.7\), 0 5px 8px -2px rgba\(0,0,0,0.4\);/g, '--shadow-lg: none;');
css = css.replace(/--shadow-xl:\s*0 24px 32px -6px rgba\(0,0,0,0.8\), 0 10px 12px -5px rgba\(0,0,0,0.3\);/g, '--shadow-xl: none;');

// 5. Replace accent colors with Brutalist (Stripe Indigo to White/Neon)
css = css.replace(/--accent:\s*#635bff;/g, '--accent: #ffffff;');
css = css.replace(/--accent-hover:\s*#7c75ff;/g, '--accent-hover: #ffffff;');

fs.writeFileSync('public/styles.css', css);
console.log('Reverted styles.css to Brutalist');
