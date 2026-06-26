const fs = require('fs');
let appJs = fs.readFileSync('public/app.js', 'utf-8');

// Inject Token IDs into HTML
const htmlRegex = /<div class="btc5m-card" \$\{onDragAttr\} data-id="\$\{m\.id\}" data-url="\$\{m\.url\}" data-question="\$\{\(m\.question \|\| ''\)\.replace\(\/"\/g, '&quot;'\)\}" style="padding:8px 10px; border:1px solid \$\{cardBorder\}; border-radius:4px; background:\$\{cardBg\}; opacity:\$\{cardOpacity\}; cursor:\$\{cardCursor\}; transition:all 0\.2s;" \$\{isFuture \? '' : `onmouseover="this\.style\.background='rgba\\(255,255,255,0\.05\\)'; this\.style\.borderColor='\$\{cardHoverBorder\}';" onmouseout="this\.style\.background='\$\{cardBg\}'; this\.style\.borderColor='\$\{cardBorder\}';"`\} \$\{onClickAttr\}>[\s\S]*?<div style="display:flex; gap:8px;">\n\s*<span style="color:var\(--neon-green\); font-size:10px;">\$\{labelYes\}: \$\{pYes\}c<\/span>\n\s*<span style="color:var\(--neon-red\); font-size:10px;">\$\{labelNo\}: \$\{pNo\}c<\/span>\n\s*<\/div>/;

const newHtml = `<div class="btc5m-card" \${onDragAttr} data-id="\${m.id}" data-url="\${m.url}" data-question="\${(m.question || '').replace(/"/g, '&quot;')}" style="padding:8px 10px; border:1px solid \${cardBorder}; border-radius:4px; background:\${cardBg}; opacity:\${cardOpacity}; cursor:\${cardCursor}; transition:all 0.2s;" \${isFuture ? '' : \`onmouseover="this.style.background='rgba(255,255,255,0.05)'; this.style.borderColor='\${cardHoverBorder}';" onmouseout="this.style.background='\${cardBg}'; this.style.borderColor='\${cardBorder}';"\`} \${onClickAttr}>
        <div style="display:flex; justify-content:space-between; margin-bottom:4px; align-items:flex-start;">
          <span style="font-weight:600; color:var(--text-primary); font-size:11px; flex:1; min-width:0; word-wrap:break-word;">\${(m.groupItemTitle || m.question || '').replace(/(Bitcoin|BTC|Ethereum|ETH|Dogecoin|DOGE) Up or Down -? ?/i, '').trim()}</span>
          <span class="short-market-timer" data-end-date="\${m.endDate}" data-p-yes="\${pYes}" data-p-no="\${pNo}" data-l-yes="\${labelYes}" data-l-no="\${labelNo}" style="color:\${timeColor}; font-weight:700; font-size:10px; white-space:nowrap; flex-shrink:0; text-align:right; margin-left:8px;">\${timeText}</span>
        </div>
        \${priceInfo}
        <div style="display:flex; justify-content:space-between; align-items:center;">
          <div style="display:flex; gap:8px;">
            <span id="price-yes-\${m.clobTokenIds?.[0] || 'none'}" style="color:var(--neon-green); font-size:10px; transition:color 0.2s;">\${labelYes}: \${pYes}c</span>
            <span id="price-no-\${m.clobTokenIds?.[1] || 'none'}" style="color:var(--neon-red); font-size:10px; transition:color 0.2s;">\${labelNo}: \${pNo}c</span>
          </div>`;

appJs = appJs.replace(htmlRegex, newHtml);

// Add SSE listener
const sseLogic = `
// --- LIVE PRICES SSE ---
const livePriceSource = new EventSource('/api/live-prices');
livePriceSource.onmessage = (event) => {
  try {
    const prices = JSON.parse(event.data);
    for (const [tokenId, price] of Object.entries(prices)) {
      if(!price) continue;
      const centPrice = Math.round(price * 100);
      
      const elYes = document.getElementById('price-yes-' + tokenId);
      if (elYes && !elYes.textContent.includes(centPrice + 'c')) {
        const label = elYes.textContent.split(':')[0];
        elYes.textContent = \`\${label}: \${centPrice}c\`;
        // Flash animation
        elYes.style.color = '#ffffff';
        setTimeout(() => elYes.style.color = 'var(--neon-green)', 300);
      }
      
      const elNo = document.getElementById('price-no-' + tokenId);
      if (elNo && !elNo.textContent.includes(centPrice + 'c')) {
        const label = elNo.textContent.split(':')[0];
        elNo.textContent = \`\${label}: \${centPrice}c\`;
        // Flash animation
        elNo.style.color = '#ffffff';
        setTimeout(() => elNo.style.color = 'var(--neon-red)', 300);
      }
    }
  } catch(e) {}
};
`;

appJs += '\n' + sseLogic;

// Disable the old 5-second polling timer
appJs = appJs.replace(/shortMarketTimer = setTimeout\(fetchShortMarkets, 5000\); \/\/ 5 detik/g, "shortMarketTimer = setTimeout(fetchShortMarkets, 60000); // 60 detik (SSE handles live prices)");

fs.writeFileSync('public/app.js', appJs);
console.log('Frontend patched for SSE.');
