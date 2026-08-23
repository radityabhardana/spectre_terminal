const MOBILE_VIEWS = ["markets", "analysis", "queue", "account"];

function element(tag, attributes = {}, content = "") {
  const node = document.createElement(tag);
  Object.entries(attributes).forEach(([name, value]) => {
    if (name === "className") node.className = value;
    else if (name === "dataset") Object.assign(node.dataset, value);
    else if (name === "textContent") node.textContent = value;
    else node.setAttribute(name, value);
  });
  if (content) node.innerHTML = content;
  return node;
}

function focusable(container) {
  return [...container.querySelectorAll(
    'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
  )].filter((node) => !node.hidden
    && node.getAttribute("aria-hidden") !== "true"
    && node.getClientRects().length > 0);
}

function initTerminalShell() {
  const workspace = document.querySelector(".workspace");
  const leftSidebar = document.querySelector("#leftSidebar");
  const controlPanel = document.querySelector(".control-panel");
  const resultPanel = document.querySelector(".result-panel");
  const queuePanel = document.querySelector("#queuePanel");
  const centerDashboard = document.querySelector("#centerDashboard");
  const topbarActions = document.querySelector(".topbar-actions");
  const statusBar = document.querySelector("#statusBar");
  const settingsModal = document.querySelector("#settingsModal");

  if (!workspace || !leftSidebar || !resultPanel || !queuePanel || !topbarActions || !statusBar) return;
  if (settingsModal && settingsModal.parentElement !== document.body) document.body.append(settingsModal);

  const skipLink = element("a", {
    className: "terminal-skip-link",
    href: "#staticResultContent",
    textContent: "Skip to analysis",
  });
  document.body.prepend(skipLink);

  leftSidebar.dataset.terminalRegion = "opportunities";
  leftSidebar.setAttribute("aria-label", "Market opportunities");
  workspace.prepend(leftSidebar);

  controlPanel?.classList.add("terminal-command-dock");
  controlPanel?.setAttribute("aria-label", "Short-market analysis");
  resultPanel.dataset.terminalRegion = "analysis";
  resultPanel.setAttribute("aria-label", "Market analysis workspace");

  const analysisFlow = element("nav", {
    id: "analysisFlow",
    className: "analysis-flow",
    "aria-label": "Analysis decision structure",
  }, `
    <button type="button" data-analysis-anchor="verdict"><span>01</span>Verdict</button>
    <button type="button" data-analysis-anchor="why"><span>02</span>Why</button>
    <button type="button" data-analysis-anchor="probability"><span>03</span>Probability + EV</button>
    <button type="button" data-analysis-anchor="risks"><span>04</span>Risks</button>
    <button type="button" data-analysis-anchor="evidence"><span>05</span>Evidence</button>
  `);
  resultPanel.querySelector(".console-head")?.after(analysisFlow);

  const staticResultContent = document.querySelector("#staticResultContent");
  const syncAnalysisState = () => {
    const empty = Boolean(staticResultContent?.querySelector(".static-result-empty"));
    resultPanel.dataset.analysisState = empty ? "empty" : "ready";
  };
  if (staticResultContent) {
    new MutationObserver(syncAnalysisState).observe(staticResultContent, { childList: true, subtree: true });
  }
  syncAnalysisState();

  analysisFlow.addEventListener("click", (event) => {
    const anchor = event.target.closest("[data-analysis-anchor]")?.dataset.analysisAnchor;
    if (!anchor || !staticResultContent) return;
    const terms = {
      verdict: ["verdict", "kesimpulan", "signal"],
      why: ["why", "alasan", "reason"],
      probability: ["probability", "probabilitas", "ev", "entry"],
      risks: ["risk", "risiko", "guardrail", "warning"],
      evidence: ["evidence", "bukti", "source", "orderbook"],
    }[anchor];
    const sectionName = { verdict: "verdict", why: "why", probability: "evidence", risks: "risks", evidence: "evidence" }[anchor];
    const target = staticResultContent.querySelector(`[data-summary-section="${sectionName}"]`)
      || [...staticResultContent.querySelectorAll("h1, h2, h3, h4, strong")]
      .find((node) => terms.some((term) => node.textContent.toLowerCase().includes(term)));
    target?.scrollIntoView({ block: "start", behavior: "smooth" });
  });

  const queueRail = element("aside", {
    id: "queueRail",
    className: "terminal-queue-rail",
    "data-terminal-region": "queue",
    "aria-label": "Dynamic EV scanner queue",
  });
  queueRail.append(queuePanel);
  workspace.append(queueRail);

  const entrySignalStatus = document.querySelector("#entrySignalStatus");
  const queuePanelContent = document.querySelector("#queuePanelContent");
  const decisionSpine = element("ol", {
    id: "entryDecisionSpine",
    className: "entry-decision-spine",
    "aria-label": "Dynamic EV decision lifecycle",
  }, `
    <li data-decision-step="watching"><span>01</span><strong>Watching</strong></li>
    <li data-decision-step="candidate"><span>02</span><strong>Candidate</strong></li>
    <li data-decision-step="entry"><span>03</span><strong>Entry</strong></li>
    <li data-decision-step="no_entry"><span>04</span><strong>No entry</strong></li>
    <li data-decision-step="no_chase"><span>05</span><strong>No chase</strong></li>
  `);
  queuePanelContent?.prepend(decisionSpine);

  const syncDecisionSpine = () => {
    const current = String(entrySignalStatus?.textContent || "WATCHING").trim().toLowerCase();
    decisionSpine.querySelectorAll("[data-decision-step]").forEach((step) => {
      const active = step.dataset.decisionStep === current;
      if (active) step.setAttribute("aria-current", "step");
      else step.removeAttribute("aria-current");
    });
  };
  if (entrySignalStatus) {
    new MutationObserver(syncDecisionSpine).observe(entrySignalStatus, { childList: true, subtree: true, characterData: true });
  }
  syncDecisionSpine();

  const toolBackdrop = element("button", {
    id: "secondaryToolsBackdrop",
    className: "terminal-tool-backdrop",
    type: "button",
    "aria-label": "Close secondary tools",
  });
  const toolDrawer = element("aside", {
    id: "secondaryToolsDrawer",
    className: "terminal-tool-drawer",
    "aria-hidden": "true",
    "aria-labelledby": "secondaryToolsTitle",
    role: "dialog",
    "aria-modal": "true",
  });
  const drawerHead = element("div", { className: "terminal-tool-head" }, `
    <div>
      <span class="terminal-eyebrow">SECONDARY WORKSPACE</span>
      <h2 id="secondaryToolsTitle">History and live intelligence</h2>
    </div>
  `);
  const drawerContent = element("div", { id: "secondaryToolsContent", className: "terminal-tool-content" });
  if (centerDashboard) drawerContent.append(centerDashboard);
  toolDrawer.append(drawerHead, drawerContent);
  document.body.append(toolBackdrop, toolDrawer);

  const settingsTrigger = element("button", {
    id: "terminalSettingsTrigger",
    className: "terminal-top-action",
    type: "button",
    "aria-label": "Open settings",
  }, '<i data-lucide="settings" aria-hidden="true"></i><span>Settings</span>');
  const drawerTrigger = element("button", {
    id: "secondaryToolsTrigger",
    className: "terminal-top-action",
    type: "button",
    "aria-controls": "secondaryToolsDrawer",
    "aria-expanded": "false",
  }, '<i data-lucide="panel-right" aria-hidden="true"></i><span>Workspace</span>');
  topbarActions.prepend(settingsTrigger, drawerTrigger);

  const mobileNav = element("nav", {
    id: "mobileTerminalNav",
    className: "terminal-mobile-nav",
    "aria-label": "Terminal views",
  }, MOBILE_VIEWS.map((view) => {
    const icon = { markets: "list-filter", analysis: "scan-search", queue: "radar", account: "scan-eye" }[view];
    const label = view === "account" ? "Tracker" : view[0].toUpperCase() + view.slice(1);
    return `<button type="button" data-mobile-view="${view}" aria-label="${label}"><i data-lucide="${icon}" aria-hidden="true"></i><span>${label}</span></button>`;
  }).join(""));
  document.body.append(mobileNav);

  const summary = element("div", { className: "terminal-summary-rail", "aria-label": "Terminal summary" }, `
    <button type="button" data-summary-target="history"><span>Win rate</span><strong id="terminalWinRateValue">0%</strong></button>
    <div><span>Mode</span><strong>MANUAL</strong></div>
  `);
  statusBar.querySelector(".padre-footer-center")?.replaceWith(summary);

  let previousFocus = null;

  function setMobileView(view) {
    if (!MOBILE_VIEWS.includes(view)) return;
    document.body.dataset.mobileView = view;
    mobileNav.querySelectorAll("[data-mobile-view]").forEach((button) => {
      const selected = button.dataset.mobileView === view;
      button.toggleAttribute("aria-current", selected);
    });
  }

  function setDrawer(open) {
    toolDrawer.classList.toggle("is-open", open);
    toolBackdrop.classList.toggle("is-open", open);
    toolDrawer.setAttribute("aria-hidden", String(!open));
    drawerTrigger.setAttribute("aria-expanded", String(open));
    if (open) {
      previousFocus = document.activeElement;
      toolDrawer.querySelector("button")?.focus();
    } else if (previousFocus instanceof HTMLElement) {
      previousFocus.focus();
    }
  }

  function openTool(target) {
    if (target === "history") document.querySelector("#btnHistory")?.click();
    else setDrawer(true);
  }

  mobileNav.addEventListener("click", (event) => {
    const button = event.target.closest("[data-mobile-view]");
    if (!button) return;
    setDrawer(false);
    setMobileView(button.dataset.mobileView);
  });
  settingsTrigger.addEventListener("click", () => {
    const settingsModal = document.querySelector("#settingsModal");
    const panel = settingsModal?.querySelector(".settings-dropdown-panel");
    if (settingsModal && panel) {
      const buttonRect = settingsTrigger.getBoundingClientRect();
      const panelWidth = Math.min(420, window.innerWidth - 20);
      const left = Math.min(
        Math.max(10, buttonRect.right - panelWidth),
        window.innerWidth - panelWidth - 10,
      );
      settingsModal.style.setProperty("--settings-dropdown-top", `${buttonRect.bottom + 8}px`);
      settingsModal.style.setProperty("--settings-dropdown-left", `${left}px`);
    }
    document.querySelector("#btnSettings")?.click();
  });
  drawerTrigger.addEventListener("click", () => {
    const isOpen = toolDrawer.classList.contains("is-open");
    setDrawer(!isOpen);
  });
  toolBackdrop.addEventListener("click", () => setDrawer(false));
  summary.addEventListener("click", (event) => {
    const target = event.target.closest("[data-summary-target]")?.dataset.summaryTarget;
    if (target === "history") openTool("history");
  });

  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      setDrawer(false);
      return;
    }
    const activeDialog = toolDrawer.classList.contains("is-open") ? toolDrawer : null;
    if (event.key !== "Tab" || !activeDialog) return;
    const items = focusable(activeDialog);
    if (!items.length) return;
    const first = items[0];
    const last = items.at(-1);
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  });

  const winRateSource = document.querySelector("#dashPlayWinRate");
  const winRateValue = document.querySelector("#terminalWinRateValue");
  const syncSummary = () => {
    if (winRateValue) winRateValue.textContent = winRateSource?.textContent?.trim() || "0%";
  };
  const observer = new MutationObserver(syncSummary);
  [winRateSource].filter(Boolean).forEach((node) => observer.observe(node, { childList: true, subtree: true, characterData: true }));

  setMobileView("markets");
  syncSummary();
  document.body.classList.add("terminal-shell-ready");
  window.lucide?.createIcons();
}

if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", initTerminalShell, { once: true });
else initTerminalShell();
