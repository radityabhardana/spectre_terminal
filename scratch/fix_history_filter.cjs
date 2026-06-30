const fs = require('fs');
let html = fs.readFileSync('public/index.html', 'utf8');

// Fix title
html = html.replace('MVPM Terminal', 'Icarus Terminal');

// Fix cache buster
html = html.replace(/styles\.css\?v=[^\"']+/g, 'styles.css?v=brutalist-v5');

// Fix the layout
const filterRegex = /<div style="padding:16px 20px; border-bottom:1px solid var\(--border\); background:rgba\(0,0,0,0\.2\); display:flex; flex-wrap:wrap; gap:32px; align-items:center;">([\s\S]*?)<\/div>\s*<div style="padding:16px 20px; display:flex; gap:20px; border-bottom:1px solid var\(--border\); background:rgba\(0,0,0,0\.3\);">/m;

const match = filterRegex.exec(html);
if (match) {
  let content = match[1];
  
  // modify content layout
  content = content.replace(/gap:12px/g, 'gap:8px');
  content = content.replace(/gap:6px/g, 'gap:2px');
  content = content.replace(/margin-left:20px;/g, '');
  content = content.replace(/padding:6px 16px/g, 'padding:4px 12px');
  content = content.replace(/font-size:12px/g, 'font-size:11px');
  content = content.replace(/font-size:11px/g, 'font-size:10px'); // labels
  content = content.replace(/border-radius:6px/g, 'border-radius:4px');
  content = content.replace(/padding:4px;/g, 'padding:2px;');
  
  // Add Reset button
  const newBlock = `
          <div style="padding:12px 20px; border-bottom:1px solid var(--border); background:rgba(0,0,0,0.2); display:flex; flex-wrap:wrap; gap:16px; align-items:center; justify-content:flex-end;">` 
          + content + 
          `
            <!-- Reset Button -->
            <button id="btnResetHistoryFilters" style="padding:4px 12px; border-radius:4px; background:rgba(239,68,68,0.1); color:#ef4444; border:1px solid rgba(239,68,68,0.3); cursor:pointer; font-size:11px; font-weight:bold; display:flex; align-items:center; gap:4px; transition:all 0.2s;">
              <i data-lucide="rotate-ccw" style="width:12px; height:12px;"></i> Reset
            </button>
          </div>
          <div style="padding:16px 20px; display:flex; gap:20px; border-bottom:1px solid var(--border); background:rgba(0,0,0,0.3);">`;
          
  html = html.replace(filterRegex, newBlock);
} else {
  console.log('No regex match!');
}

fs.writeFileSync('public/index.html', html);
console.log('Fixed index.html');
