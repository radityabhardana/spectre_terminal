# AGENTS.md - Razor Bot Project Rules & Automatic Skill Routing

This file is automatically loaded into the AI agent context on every session and prompt. It defines core guardrails, project conventions, and automatic skill routing rules for Razor Bot.

---

## 1. Safety & EV Guardrails (NON-NEGOTIABLE)

### Aggressive Overrides & AI Confidence Guardrails
When building or modifying "Aggressive", "Degen", or "Forced Trade" modes, **NEVER** allow these modes to unconditionally override AI confidence or anti-hallucination guardrails. If an AI explicitly reports critically low confidence (e.g., data unreadable, broken context), the system **MUST** abort the trade/action and fall back to a safe neutral state, regardless of any user-enabled "aggressive" settings. Aggressive settings should only force decisions in ambiguous (50-50) but valid data states, not in corrupted or unreadable data states.

### Max Entry Price & EV Guardrails (Anti-Overpaying Rule)
**NEVER** execute or recommend a trade (PLAY) if the binary outcome token price is overpriced relative to expected value or exceeds safe risk/reward boundaries (e.g. buying above 0.70-0.75). Even if directional prediction (UP/DOWN) is correct at resolution, overpaying for binary tokens creates severe asymmetric downside risk (-100% loss vs small upside gain) and negative expected value (EV). High entry prices (> 0.70) must be automatically filtered out to **AVOID**.

---

## 2. Automatic Skill Routing System

Whenever a user prompt mentions or touches a specific topic, the AI agent MUST automatically reference and enforce the corresponding Skill guidelines below:

| Prompt Topic / Keywords | Trigger Skill Name | Skill Path | Purpose / Guidance |
| :--- | :--- | :--- | :--- |
| **Trading Security, Wallet, Order Placement, 9Router** | `llm-trading-agent-security` | `.agents/skills/llm-trading-agent-security/SKILL.md` | Enforce spend limits, pre-send simulation, circuit breakers, and prompt injection defense on trading tools. |
| **Polymarket Research, Odds, EV, Orderbook Analysis** | `ito-trade-planner` | `.agents/skills/ito-trade-planner/SKILL.md` | Structure prediction-market trade planning, EV calculations, and orderbook probability inspection. |
| **Polygon / USDC / Token Precision** | `evm-token-decimals` | `.agents/skills/evm-token-decimals/SKILL.md` | Ensure chain-aware token decimal precision across Polygon USDC and binary outcome tokens. |
| **Node.js ESM, Express, SQLite, WebSockets** | `backend-patterns` | `.agents/skills/backend-patterns/SKILL.md` | Enforce Node.js ESM best practices, `better-sqlite3` query safety, and WebSocket hygiene. |
| **Multi-API Fetching, Crash Prevention, Retries** | `error-handling` | `.agents/skills/error-handling/SKILL.md` | Handle multi-source API failures (Binance, DefiLlama, GDELT, Telegram) with graceful fallbacks and circuit breakers. |
| **`.env`, Auth, Password, API Keys, Input Sanitization** | `security-review` | `.agents/skills/security-review/SKILL.md` | Audit sensitive credentials, Web Basic Auth, Telegram input injection, and private key safety. |
| **UI/UX Design, CSS, Frontend Dashboard (`public/`)** | `design-taste-frontend` / `minimalist-ui` | `.agents/skills/taste-skill/SKILL.md` & `.agents/skills/minimalist-skill/SKILL.md` | Enforce anti-slop UI design: JetBrains Mono/Geist fonts, 1 accent color, dark tech theme, tactile feedback, no generic gradients. |
| **Writing / Editing Large JS/Node Files** | `full-output-enforcement` | `.agents/skills/output-skill/SKILL.md` | Ban placeholder comments (`// TODO`, `// ...`), enforce unabridged, complete code generation. |
| **Running Code, Testing, Verifying Changes** | `verification-loop` | `.agents/skills/verification-loop/SKILL.md` | Run `npm run check` (`node --check`) and `npm test` after any code modification before declaring completion. |
| **Brand Identity, Logo, Visual System** | `brandkit` | `.agents/skills/brandkit/SKILL.md` | Generate premium brand-kit boards, logo systems, identity decks, and visual-world presentations. |
| **Brutalist Design, Terminal Aesthetic, Data-Heavy Dashboard** | `industrial-brutalist-ui` | `.agents/skills/brutalist-skill/SKILL.md` | Raw mechanical interfaces with Swiss typographic print and military terminal aesthetics. Rigid grids, extreme type scale contrast, utilitarian color. |
| **GSAP, ScrollTrigger, Advanced Motion, Animation** | `gpt-taste` | `.agents/skills/gpt-tasteskill/SKILL.md` | Enforce Python-driven randomization for layout variance, strict AIDA page structure, wide editorial typography, gapless bento grids, strict GSAP ScrollTriggers, and massive section spacing. |
| **Screenshot to Code, Image to Website, Visual Reference** | `image-to-code` | `.agents/skills/image-to-code-skill/SKILL.md` | Generate design images first, deeply analyze them, then implement the website to match. Avoid lazy under-generation and cards-inside-cards UI. |
| **Mobile App UI, iOS/Android Screen Design** | `imagegen-frontend-mobile` | `.agents/skills/imagegen-frontend-mobile/SKILL.md` | Generate premium, app-native mobile screen concepts with clean hierarchy, readable text, multi-screen consistency, and phone mockup framing. |
| **Web Design Reference, Landing Page Mockup, Section Images** | `imagegen-frontend-web` | `.agents/skills/imagegen-frontend-web/SKILL.md` | Generate one separate image per section for landing pages. Enforce composition variety, narrative concept spine, and a single consistent palette. |
| **Ponytail, Be Lazy, Simplest Solution, YAGNI, Do Less, Minimal Solution** | `ponytail` | `.agents/skills/ponytail/SKILL.md` | Force the laziest working solution. Question whether the task needs to exist, reach for stdlib before custom code, one line before fifty. |
| **Ponytail Audit, Audit for Over-engineering, Find Bloat, What Can I Delete** | `ponytail-audit` | `.agents/skills/ponytail-audit/SKILL.md` | Whole-repo audit for over-engineering. Scan entire codebase for what to delete, simplify, or replace with stdlib/native equivalents. |
| **Ponytail Debt, Ponytail Ledger, What Did Ponytail Defer, List Shortcuts** | `ponytail-debt` | `.agents/skills/ponytail-debt/SKILL.md` | Harvest every `ponytail:` comment in the codebase into a debt ledger to track deliberate shortcuts and deferrals. |
| **Ponytail Gain, Show Ponytail Impact, Ponytail Scoreboard** | `ponytail-gain` | `.agents/skills/ponytail-gain/SKILL.md` | Display ponytail's measured impact as a compact scoreboard: less code, less cost, more speed from benchmark medians. |
| **Ponytail Help, What Ponytail Commands, How to Use Ponytail** | `ponytail-help` | `.agents/skills/ponytail-help/SKILL.md` | Quick-reference card for all ponytail modes, skills, and commands. One-shot display. |
| **Ponytail Review, Review for Over-engineering, What Can We Delete, Simplify Review** | `ponytail-review` | `.agents/skills/ponytail-review/SKILL.md` | Code review focused on over-engineering. Find what to delete: reinvented stdlib, unneeded deps, speculative abstractions, dead flexibility. |
| **Redesign, Upgrade Existing Website, Fix Generic AI Design** | `redesign-existing-projects` | `.agents/skills/redesign-skill/SKILL.md` | Audit current design, identify generic AI patterns, and apply high-end design standards without breaking functionality. |
| **Premium Design, High-End Agency, Expensive Look, Fancy Animations** | `high-end-visual-design` | `.agents/skills/soft-skill/SKILL.md` | Design like a high-end agency with exact fonts, spacing, shadows, card structures, and animations that make a website feel expensive. |
| **Design System, Stitch, DESIGN.md, Token System** | `stitch-design-taste` | `.agents/skills/stitch-skill/SKILL.md` | Generate agent-friendly DESIGN.md files enforcing premium anti-generic UI standards with strict typography, calibrated color, and perpetual micro-motion. |
| **Taste V1, Backward Compatibility, Legacy Taste Skill** | `design-taste-frontend-v1` | `.agents/skills/taste-skill-v1/SKILL.md` | Original v1 taste-skill preserved for exact backward compatibility when v2 experimental behavior is not desired. |

### Global ECC Skills (auto-detected from `~/.gemini/config/skills/`)

| Prompt Topic / Keywords | Trigger Skill Name | Skill Path (Global) | Purpose / Guidance |
| :--- | :--- | :--- | :--- |
| **Coding Style, Naming, Readability, Code Review** | `coding-standards` | `~/.gemini/config/skills/coding-standards/SKILL.md` | Cross-project naming, readability, immutability, and code-quality conventions. |
| **React, Next.js, Frontend Components** | `frontend-patterns` | `~/.gemini/config/skills/frontend-patterns/SKILL.md` | React, Next.js, state management, performance optimization, and UI best practices. |
| **Frontend Visual Direction, Aesthetic Choices** | `frontend-design` | `~/.gemini/config/skills/frontend-design/SKILL.md` | Distinctive, intentional visual design direction — typography, aesthetic choices, non-templated defaults. |
| **Accessibility, ARIA, WCAG, Screen Reader** | `accessibility` | `~/.gemini/config/skills/accessibility/SKILL.md` | WCAG 2.2 Level AA — semantic ARIA, keyboard nav, screen reader support. |
| **SEO, Meta Tags, Structured Data, Core Web Vitals** | `seo` | `~/.gemini/config/skills/seo/SKILL.md` | Technical SEO, on-page optimization, structured data, Core Web Vitals. |
| **REST API Design, Endpoints, Status Codes, Pagination** | `api-design` | `~/.gemini/config/skills/api-design/SKILL.md` | REST API resource naming, status codes, pagination, filtering, versioning, rate limiting. |
| **Adding New API Integration, Provider, Connector** | `api-connector-builder` | `~/.gemini/config/skills/api-connector-builder/SKILL.md` | Build a new API connector by matching the repo's existing integration pattern. |
| **Vite, vite.config, Bundler, HMR** | `vite-patterns` | `~/.gemini/config/skills/vite-patterns/SKILL.md` | Vite config, plugins, HMR, env variables, proxy setup, dependency pre-bundling. |
| **Docker, docker-compose, Container, Dockerfile** | `docker-patterns` | `~/.gemini/config/skills/docker-patterns/SKILL.md` | Docker/Compose patterns for local dev, container security, networking, volumes. |
| **Deploy, CI/CD, Production, Health Check, Rollback** | `deployment-patterns` | `~/.gemini/config/skills/deployment-patterns/SKILL.md` | Deployment workflows, CI/CD pipelines, Docker, health checks, rollback strategies. |
| **Database Migration, Schema Change, Rollback** | `database-migrations` | `~/.gemini/config/skills/database-migrations/SKILL.md` | Schema changes, data migrations, rollbacks, zero-downtime deployments. |
| **Redis, Caching, Rate Limiting, Pub/Sub** | `redis-patterns` | `~/.gemini/config/skills/redis-patterns/SKILL.md` | Redis data structures, caching strategies, distributed locks, rate limiting. |
| **Keccak256, Ethereum Hash, sha3, Function Selector** | `nodejs-keccak256` | `~/.gemini/config/skills/nodejs-keccak256/SKILL.md` | Prevent Ethereum hashing bugs — Node's sha3-256 is NOT Keccak-256. |
| **DeFi, AMM, Liquidity Pool, Swap, Solidity Security** | `defi-amm-security` | `~/.gemini/config/skills/defi-amm-security/SKILL.md` | AMM contract security: reentrancy, CEI ordering, oracle manipulation, slippage. |
| **Prediction Market Oracle, Data Source, Signal** | `prediction-market-oracle-research` | `~/.gemini/config/skills/prediction-market-oracle-research/SKILL.md` | Research prediction markets as data sources, oracle signals, and decision inputs. |
| **Prediction Market Risk, Compliance, Safety Review** | `prediction-market-risk-review` | `~/.gemini/config/skills/prediction-market-risk-review/SKILL.md` | Review prediction-market workflows for compliance, safety, data-quality, privacy. |
| **Itô Basket Compare, Portfolio, Watchlist** | `ito-basket-compare` | `~/.gemini/config/skills/ito-basket-compare/SKILL.md` | Compare Itô baskets against user portfolio, watchlist, or financial context. |
| **Itô Compute, GPU, RFQ** | `ito-compute` | `~/.gemini/config/skills/ito-compute/SKILL.md` | Query GPU inventory, submit Itô RFQ, inspect procurement status. |
| **Itô Data Atlas, Market Discovery, Background Agent** | `ito-data-atlas-agent` | `~/.gemini/config/skills/ito-data-atlas-agent/SKILL.md` | Design background agents for Itô basket research, market discovery, parameter drafting. |
| **Itô Market Intelligence, Venue, Liquidity, News** | `ito-market-intelligence` | `~/.gemini/config/skills/ito-market-intelligence/SKILL.md` | Research prediction-market events, venues, underliers, liquidity, and news context. |
| **Latency, Real-Time, Streaming, p95, Data Freshness** | `latency-critical-systems` | `~/.gemini/config/skills/latency-critical-systems/SKILL.md` | Optimize latency-sensitive systems: realtime dashboards, market data, execution gateways. |
| **LLM Cost, Token Budget, Model Routing, Prompt Caching** | `cost-aware-llm-pipeline` | `~/.gemini/config/skills/cost-aware-llm-pipeline/SKILL.md` | Cost optimization for LLM API usage — model routing, budget tracking, prompt caching. |
| **TDD, Test-Driven Development, Write Tests First** | `tdd-workflow` | `~/.gemini/config/skills/tdd-workflow/SKILL.md` | Test-driven development with 80%+ coverage including unit, integration, and E2E tests. |
| **Test First, Red-Green-Refactor** | `test-driven-development` | `~/.gemini/config/skills/test-driven-development/SKILL.md` | Write tests before implementation code for any feature or bugfix. |
| **Playwright, E2E Test, End-to-End, Browser Test** | `e2e-testing` | `~/.gemini/config/skills/e2e-testing/SKILL.md` | Playwright E2E testing: Page Object Model, CI/CD integration, artifact management. |
| **Test Web App, Browser Interaction, UI Test** | `webapp-testing` | `~/.gemini/config/skills/webapp-testing/SKILL.md` | Interact with and test local web apps using Playwright — screenshots, browser logs. |
| **Visual Testing, Browser QA, UI Verification** | `browser-qa` | `~/.gemini/config/skills/browser-qa/SKILL.md` | Automate visual testing and UI interaction verification using browser automation. |
| **Safety Guard, Destructive Operation, Production Protection** | `safety-guard` | `~/.gemini/config/skills/safety-guard/SKILL.md` | Prevent destructive operations when working on production systems or autonomous agents. |
| **Security Bounty, Hunt Vulnerabilities, Exploit** | `security-bounty-hunter` | `~/.gemini/config/skills/security-bounty-hunter/SKILL.md` | Hunt for exploitable, bounty-worthy security issues — remotely reachable vulnerabilities. |
| **Security Scan, Agent Config Audit** | `security-scan` | `~/.gemini/config/skills/security-scan/SKILL.md` | Scan agent configuration for security vulnerabilities, misconfigurations, injection risks. |
| **Deep Research, Multi-Source, Citations, Report** | `deep-research` | `~/.gemini/config/skills/deep-research/SKILL.md` | Multi-source deep research with web search, synthesis, and cited reports. |
| **Exa Search, Neural Search, Web Search, Code Search** | `exa-search` | `~/.gemini/config/skills/exa-search/SKILL.md` | Neural search via Exa MCP for web, code, and company research. |
| **Search First, Research Before Code, Find Existing** | `search-first` | `~/.gemini/config/skills/search-first/SKILL.md` | Research-before-coding workflow — search for existing tools before writing custom code. |
| **Research, Fresh Facts, Comparisons, Evidence** | `research-ops` | `~/.gemini/config/skills/research-ops/SKILL.md` | Evidence-first current-state research for fresh facts, comparisons, and recommendations. |
| **Brainstorm, Creative Work, Feature Idea, Explore** | `brainstorming` | `~/.gemini/config/skills/brainstorming/SKILL.md` | Explore user intent, requirements, and design before implementation for creative work. |
| **Parallel Agents, Independent Tasks, Dispatch** | `dispatching-parallel-agents` | `~/.gemini/config/skills/dispatching-parallel-agents/SKILL.md` | Handle 2+ independent tasks in parallel without shared state or sequential dependencies. |
| **Execute Plan, Implementation, Checkpoints** | `executing-plans` | `~/.gemini/config/skills/executing-plans/SKILL.md` | Execute written implementation plans in separate sessions with review checkpoints. |
| **Subagent, Multi-Agent, Parallel Implementation** | `subagent-driven-development` | `~/.gemini/config/skills/subagent-driven-development/SKILL.md` | Execute implementation plans with independent tasks using subagents in current session. |
| **Write Plan, Spec, Requirements, Multi-Step** | `writing-plans` | `~/.gemini/config/skills/writing-plans/SKILL.md` | Create plans from specs or requirements for multi-step tasks, before touching code. |
| **Code Review, PR Review, Merge Review** | `requesting-code-review` | `~/.gemini/config/skills/requesting-code-review/SKILL.md` | Verify work meets requirements before merging — after completing tasks or major features. |
| **Debug, Bug, Test Failure, Unexpected Behavior** | `systematic-debugging` | `~/.gemini/config/skills/systematic-debugging/SKILL.md` | Structured debugging for any bug, test failure, or unexpected behavior — before proposing fixes. |
| **Production Audit, Pre-Launch, What Breaks in Prod** | `production-audit` | `~/.gemini/config/skills/production-audit/SKILL.md` | Local-evidence production readiness audit for shipped apps and pre-launch reviews. |
| **Design System, Visual Consistency, Style Audit** | `design-system` | `~/.gemini/config/skills/design-system/SKILL.md` | Generate or audit design systems, check visual consistency, review style-touching PRs. |
| **Interface Polish, UI Spacing, Micro Details** | `make-interfaces-feel-better` | `~/.gemini/config/skills/make-interfaces-feel-better/SKILL.md` | Apply design-engineering details that make interfaces feel polished — spacing, alignment. |
| **Motion, Animation, Transitions, React Animation** | `motion-ui` | `~/.gemini/config/skills/motion-ui/SKILL.md` | Production-ready UI motion system for React/Next.js — animations, transitions, patterns. |
| **Git, Branch, Commit, Merge, Rebase, Conflict** | `git-workflow` | `~/.gemini/config/skills/git-workflow/SKILL.md` | Branching strategies, commit conventions, merge vs rebase, conflict resolution. |
| **Finish Branch, Integrate Work, Post-Implementation** | `finishing-a-development-branch` | `~/.gemini/config/skills/finishing-a-development-branch/SKILL.md` | Decide how to integrate work when implementation is complete and all tests pass. |
| **Decision, Tradeoff, Go/No-Go, Multiple Options** | `council` | `~/.gemini/config/skills/council/SKILL.md` | Convene four-voice council for ambiguous decisions — structured disagreement before choosing. |
| **Product, Why Build, Validate Direction, Diagnostics** | `product-lens` | `~/.gemini/config/skills/product-lens/SKILL.md` | Validate the "why" before building — product diagnostics and direction pressure-testing. |
| **Monitoring Dashboard, Grafana, Metrics, Operator** | `dashboard-builder` | `~/.gemini/config/skills/dashboard-builder/SKILL.md` | Build monitoring dashboards that answer real operator questions. |
| **Fact Gate, Block Edits, Investigate First** | `gateguard` | `~/.gemini/config/skills/gateguard/SKILL.md` | Fact-forcing gate — demands concrete investigation before allowing edit/write/bash actions. |
| **Repo Scan, Source Audit, File Classification** | `repo-scan` | `~/.gemini/config/skills/repo-scan/SKILL.md` | Cross-stack source code asset audit — classifies files, detects embedded third-party libs. |
| **Context Budget, Token Audit, Bloat Detection** | `context-budget` | `~/.gemini/config/skills/context-budget/SKILL.md` | Audit context window consumption — identify bloat, redundant components, token savings. |
| **Compact Context, Preserve Memory, Context Phase** | `strategic-compact` | `~/.gemini/config/skills/strategic-compact/SKILL.md` | Manual context compaction at logical intervals to preserve context through task phases. |
| **Growth Log, Lessons Learned, Post-Mortem** | `growth-log` | `~/.gemini/config/skills/growth-log/SKILL.md` | Write growth logs that extract reusable patterns after complex tasks or failures. |
| **Docs Lookup, Library API, Framework Reference** | `documentation-lookup` | `~/.gemini/config/skills/documentation-lookup/SKILL.md` | Use up-to-date library/framework docs via Context7 MCP instead of stale training data. |
| **MCP Server, Build MCP, Tools, Resources** | `mcp-server-patterns` | `~/.gemini/config/skills/mcp-server-patterns/SKILL.md` | Build MCP servers with Node/TypeScript SDK — tools, resources, Zod validation. |
| **Accessibility, ARIA, Keyboard Nav, Form Label** | `frontend-a11y` | `~/.gemini/config/skills/frontend-a11y/SKILL.md` | React/Next.js accessibility — semantic HTML, ARIA, form labeling, keyboard navigation. |

---

## 3. Core Development Rules

1. **Verification Mandatory**: After editing any file in `src/`, `public/`, or `scripts/`, run `npm run check` or `npm test` to verify zero syntax/runtime regressions.
2. **No Truncation**: Deliver complete files and unabridged code snippets. Never use `// TODO` or `// ...` placeholders.
3. **Privacy First**: Never expose `.env` API keys, Telegram Bot Tokens, or private keys in logs or git commits.
