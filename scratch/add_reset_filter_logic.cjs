const fs = require('fs');
let app = fs.readFileSync('public/app.js', 'utf8');

const targetStr = `
  const btnClearHistoryDate = document.getElementById("btnClearHistoryDate");
  if (btnClearHistoryDate) {
    btnClearHistoryDate.addEventListener("click", () => {
      const sd = document.getElementById("historyStartDate");
      const ed = document.getElementById("historyEndDate");
      if (sd) sd.value = "";
      if (ed) ed.value = "";
      fetchHistoryEvents();
    });
  }
`;

const replaceStr = targetStr + `
  const btnResetHistoryFilters = document.getElementById("btnResetHistoryFilters");
  if (btnResetHistoryFilters) {
    btnResetHistoryFilters.addEventListener("click", () => {
      // Clear Dates
      const sd = document.getElementById("historyStartDate");
      const ed = document.getElementById("historyEndDate");
      if (sd) sd.value = "";
      if (ed) ed.value = "";
      
      // Reset Asset Filter to 'all'
      document.querySelectorAll(".history-asset-btn").forEach(b => {
        b.classList.remove("active");
        b.style.background = "transparent";
        b.style.color = "var(--text-secondary)";
        if (b.getAttribute("data-asset") === "all") {
          b.classList.add("active");
          b.style.background = "var(--neon-amber)";
          b.style.color = "#000";
        }
      });
      currentHistoryAsset = "all";
      
      // Reset Duration Filter to 'all'
      document.querySelectorAll(".history-duration-btn").forEach(b => {
        b.classList.remove("active");
        b.style.background = "transparent";
        b.style.color = "var(--text-secondary)";
        if (b.getAttribute("data-duration") === "all") {
          b.classList.add("active");
          b.style.background = "var(--neon-purple)";
          b.style.color = "#fff";
        }
      });
      currentHistoryDuration = "all";
      
      // Refetch
      fetchHistoryEvents();
    });
  }
`;

app = app.replace(targetStr, replaceStr);
fs.writeFileSync('public/app.js', app);
console.log('Added Reset Filter logic');
