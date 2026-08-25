# Katalog Skill Razor Bot

Panduan ini dibuat untuk dibaca manusia saat memilih skill yang cocok untuk sebuah tugas.

> `SKILLS_GUIDE.md` bukan konfigurasi auto-routing dan tidak otomatis dibaca agent. Ketersediaan skill bergantung pada agent/harness yang sedang dipakai. Aturan proyek yang aktif tetap berada di `.agents/AGENTS.md`.

## Navigasi

- [Cara Memilih Skill](#cara-memilih-skill)
- [Quick Picker](#quick-picker)
- [Shortlist Harian](#shortlist-harian)
- [Katalog Skill Lokal](#katalog-skill-lokal)
- [Katalog Skill OpenCode](#katalog-skill-opencode)
- [Template Meminta Agent Memakai Skill](#template-meminta-agent-memakai-skill)

## Cara Memilih Skill

Gunakan sesedikit mungkin skill:

1. Pilih **1 skill utama** yang paling tepat dengan tugas.
2. Tambahkan maksimal **2 skill pendamping** jika memang memberi fungsi berbeda.
3. Jangan menggabungkan banyak skill desain, testing, atau workflow yang saling tumpang tindih.
4. Untuk skill lokal, minta agent membaca file `SKILL.md` yang ditautkan.
5. Untuk skill yang sudah terdaftar di OpenCode, minta agent melakukan `invoke` melalui tool `skill`.

Menjalankan test/check adalah langkah wajib proyek. Skill verification seperti `verification-loop` atau `verification-before-completion` **tidak menghitung kuota** 2 pendamping.

Jika nama skill tersedia sebagai skill lokal dan skill registry, prioritaskan versi lokal karena instruksinya dapat disesuaikan dengan repository ini.

### Arti Prioritas

| Prioritas | Arti |
|---|---|
| **CORE** | Sangat relevan dengan domain, stack, atau workflow harian Razor Bot. |
| **SITUASIONAL** | Berguna ketika tugasnya benar-benar menyentuh area tersebut. |
| **OPSIONAL** | Bukan kebutuhan stack utama saat ini, tetapi tersedia untuk pekerjaan khusus. |

## Quick Picker

Mulai dari tabel ini. Jika sudah menemukan pasangan yang cocok, tidak perlu membaca seluruh katalog.

> Jika tugas belum jelas ruang lingkupnya, gunakan `brainstorming` dulu sebelum memilih skill lain.

| Kebutuhan | Skill utama (+ Sumber) | Pendamping yang masuk akal (+ Sumber) |
|---|---|---|
| Kejelasan requirement belum diketahui | `brainstorming` (Registry) | — |
| Mengubah scanner, EV, probabilitas, atau orderbook | `ito-trade-planner` (Lokal) | `test-driven-development` (Registry) |
| Mengubah wallet, eksekusi order, atau live trading | `llm-trading-agent-security` (Lokal) | `evm-token-decimals` (Lokal), `security-review` (Lokal) |
| Memperbaiki bug atau test gagal | `systematic-debugging` (Registry) | `test-driven-development` (Registry) |
| Menambah endpoint atau logic backend Node.js | `backend-patterns` (Lokal) | `api-design` (Registry), `error-handling` (Lokal) |
| Memperbaiki API eksternal yang timeout/error | `error-handling` (Lokal) | `backend-patterns` (Lokal), `latency-critical-systems` (Registry) |
| Mengubah SQLite, schema, atau query | `backend-patterns` (Lokal) | `database-migrations` (Registry), `security-review` (Lokal) |
| Audit auth, input, secret, atau XSS | `security-review` (Lokal) | `safety-guard` (Registry), `requesting-code-review` (Registry) |
| Mengubah dashboard atau CSS yang sudah ada | `design-taste-frontend` (Lokal) | `make-interfaces-feel-better` (Registry), `accessibility` (Registry) |
| Menguji flow UI di browser | `webapp-testing` (Registry) | `browser-qa` (Registry), `e2e-testing` (Registry) |
| Mengoptimalkan realtime, stream, atau p95 | `latency-critical-systems` (Registry) | `backend-patterns` (Lokal) |
| Menambah integrasi API/provider | `api-connector-builder` (Registry) | `api-design` (Registry), `error-handling` (Lokal) |
| Menyiapkan deploy atau container | `deployment-patterns` (Registry) | `docker-patterns` (Registry), `production-audit` (Registry) |
| Mencari dokumentasi library terbaru | `documentation-lookup` (Registry) | `search-first` (Registry) |
| Membuat rencana fitur kompleks | `writing-plans` (Registry) | `brainstorming` (Registry), `product-lens` (Registry) |
| Menjalankan plan yang sudah disetujui | `executing-plans` (Registry) | `subagent-driven-development` (Registry) |
| Review perubahan sebelum dianggap selesai | `requesting-code-review` (Registry) | `security-review` (Lokal) |
| Menyederhanakan kode yang terlalu rumit | `ponytail` (Lokal) | `ponytail-review` (Lokal) |
| Audit kesiapan production | `production-audit` (Registry) | `security-review` (Lokal), `deployment-patterns` (Registry) |

## Shortlist Harian

Ini bukan daftar semua skill berlabel CORE. Ini shortcut untuk skill yang paling sering dipilih saat mengembangkan Razor Bot; detail dan prioritas lengkap tetap ada di katalog.

| Skill | Sumber | Fungsi utama |
|---|---|---|
| `ito-trade-planner` | Lokal | Analisis prediction market, probabilitas, EV, dan orderbook. |
| `llm-trading-agent-security` | Lokal | Guardrail wallet, order, spend limit, simulasi, dan circuit breaker. |
| `backend-patterns` | Lokal | Pola Node.js ESM, API, SQLite, dan service backend. |
| `error-handling` | Lokal | Timeout, retry, fallback, dan kegagalan multi-provider. |
| `security-review` | Lokal | Auth, secret, validasi input, XSS, dan endpoint sensitif. |
| `systematic-debugging` | Registry | Mencari root cause sebelum mengubah kode. |
| `test-driven-development` | Registry | Regression test dan siklus red-green-refactor. |
| `verification-loop` | Lokal | Menjalankan syntax check dan test proyek. |
| `verification-before-completion` | Registry | Memastikan klaim selesai selalu didukung output verifikasi terbaru. |
| `requesting-code-review` | Registry | Review correctness, security, dan regression sebelum selesai. |
| `latency-critical-systems` | Registry | Realtime data, WebSocket, freshness, dan p95 latency. |
| `design-taste-frontend` | Lokal | Menjaga dashboard tetap konsisten dan tidak generik. |
| `webapp-testing` | Registry | Memastikan flow UI benar melalui browser automation. |

---

# Katalog Skill Lokal (26 Skill)

Skill lokal berada di `.agents/skills/`. Tautan di bawah mengarah langsung ke file `SKILL.md` masing-masing.

## Trading, Blockchain, dan Security

| Skill | Prioritas | Pakai ketika | Jangan dipakai ketika |
|---|---|---|---|
| [`llm-trading-agent-security`](.agents/skills/llm-trading-agent-security/SKILL.md) | **CORE** | Mengubah wallet, spend limit, order placement, gateway transaksi seperti OmniRoute, prompt injection, atau circuit breaker. | Hanya menampilkan data market tanpa kemampuan transaksi. |
| [`ito-trade-planner`](.agents/skills/ito-trade-planner/SKILL.md) | **CORE** | Menilai odds, EV, orderbook, constraint, atau langkah manual prediction market. | Meminta rekomendasi investasi atau eksekusi otomatis tanpa guardrail. |
| [`evm-token-decimals`](.agents/skills/evm-token-decimals/SKILL.md) | **SITUASIONAL** | Menangani Polygon, USDC, outcome token, normalisasi unit, atau precision lintas chain. | Tidak ada nilai token/on-chain yang diproses. |

## Backend dan Reliability

| Skill | Prioritas | Pakai ketika | Jangan dipakai ketika |
|---|---|---|---|
| [`backend-patterns`](.agents/skills/backend-patterns/SKILL.md) | **CORE** | Mengubah Node.js ESM, endpoint, SQLite, WebSocket, service, atau `src/`. | Perubahan murni visual atau dokumentasi. |
| [`error-handling`](.agents/skills/error-handling/SKILL.md) | **CORE** | Mengatur timeout, retry, fallback, typed error, atau kegagalan API eksternal. | Tidak ada jalur error/asynchronous yang berubah. |
| [`security-review`](.agents/skills/security-review/SKILL.md) | **CORE** | Menangani auth, `.env`, API key, input user, XSS, endpoint, wallet, atau data sensitif. | Perubahan statis yang tidak menyentuh trust boundary. |
| [`verification-loop`](.agents/skills/verification-loop/SKILL.md) | **CORE** | Menentukan dan menjalankan syntax check/test proyek selama dan setelah implementasi. | Tidak ada file atau behavior yang berubah. |
| [`full-output-enforcement`](.agents/skills/output-skill/SKILL.md) | **OPSIONAL** | Membutuhkan output kode/file lengkap tanpa placeholder atau pemotongan. | Edit kecil langsung di workspace. |

## UI, Visual, dan Brand

Gunakan satu arah visual utama. Jangan menumpuk beberapa taste skill kecuali memang membandingkan alternatif.

| Skill | Prioritas | Pakai ketika | Catatan |
|---|---|---|---|
| [`design-taste-frontend`](.agents/skills/taste-skill/SKILL.md) | **CORE** | Mengubah UI/dashboard Razor Bot yang sudah ada. | Pilihan default untuk menjaga bahasa visual sekarang. |
| [`minimalist-ui`](.agents/skills/minimalist-skill/SKILL.md) | **SITUASIONAL** | Ingin tampilan editorial, bersih, flat, dan minim efek. | Bisa bertentangan dengan arah terminal/brutalist. |
| [`industrial-brutalist-ui`](.agents/skills/brutalist-skill/SKILL.md) | **SITUASIONAL** | Membuat terminal/data dashboard yang raw, mekanis, dan padat. | Gunakan sebagai arah alternatif, bukan lapisan tambahan. |
| [`high-end-visual-design`](.agents/skills/soft-skill/SKILL.md) | **OPSIONAL** | Membutuhkan landing page atau visual agency premium. | Bukan default untuk dashboard operasional. |
| [`gpt-taste`](.agents/skills/gpt-tasteskill/SKILL.md) | **OPSIONAL** | Membuat landing page dengan GSAP, ScrollTrigger, atau motion editorial berat. | Terlalu berat untuk perubahan UI kecil. |
| [`redesign-existing-projects`](.agents/skills/redesign-skill/SKILL.md) | **SITUASIONAL** | Melakukan redesign menyeluruh tanpa merusak fitur yang ada. | Jangan dipakai untuk satu komponen kecil. |
| [`stitch-design-taste`](.agents/skills/stitch-skill/SKILL.md) | **OPSIONAL** | Membuat `DESIGN.md` atau design system untuk Google Stitch. | Tidak diperlukan untuk implementasi CSS biasa. |
| [`design-taste-frontend-v1`](.agents/skills/taste-skill-v1/SKILL.md) | **OPSIONAL** | Proyek bergantung pada behavior taste skill versi lama. | Gunakan versi utama untuk pekerjaan baru. |
| [`brandkit`](.agents/skills/brandkit/SKILL.md) | **OPSIONAL** | Membuat identitas brand, logo system, atau guideline board. | Bukan skill implementasi dashboard. |
| [`image-to-code`](.agents/skills/image-to-code-skill/SKILL.md) | **OPSIONAL** | Ada screenshot/reference visual yang harus direplikasi ke kode. | Tidak diperlukan jika desain sudah tersedia di codebase. |
| [`imagegen-frontend-mobile`](.agents/skills/imagegen-frontend-mobile/SKILL.md) | **OPSIONAL** | Membuat konsep layar aplikasi mobile. | Razor Bot saat ini bukan aplikasi mobile native. |
| [`imagegen-frontend-web`](.agents/skills/imagegen-frontend-web/SKILL.md) | **OPSIONAL** | Membuat reference image per section untuk landing page web. | Tidak diperlukan untuk dashboard maintenance. |

## Simplifikasi dengan Ponytail

| Skill | Prioritas | Pakai ketika |
|---|---|---|
| [`ponytail`](.agents/skills/ponytail/SKILL.md) | **SITUASIONAL** | Ingin solusi terkecil yang benar, YAGNI, dan tanpa dependency/abstraksi berlebih. |
| [`ponytail-review`](.agents/skills/ponytail-review/SKILL.md) | **SITUASIONAL** | Review diff khusus untuk mencari hal yang bisa dihapus atau disederhanakan. |
| [`ponytail-audit`](.agents/skills/ponytail-audit/SKILL.md) | **OPSIONAL** | Audit seluruh repository untuk over-engineering dan bloat. |
| [`ponytail-debt`](.agents/skills/ponytail-debt/SKILL.md) | **OPSIONAL** | Mengumpulkan komentar `ponytail:` menjadi debt ledger. |
| [`ponytail-gain`](.agents/skills/ponytail-gain/SKILL.md) | **OPSIONAL** | Melihat scoreboard dampak Ponytail. |
| [`ponytail-help`](.agents/skills/ponytail-help/SKILL.md) | **OPSIONAL** | Membuka quick reference semua mode Ponytail. |

---

# Katalog Skill OpenCode

Bagian ini berisi skill tambahan yang relevan dan pernah dicantumkan untuk Razor Bot. Lokasi instalasinya dapat berbeda antar mesin. Pastikan nama skill muncul pada registry OpenCode sebelum meminta `invoke`.

## Engineering dan API

| Skill | Prioritas | Pakai ketika |
|---|---|---|
| `coding-standards` | **CORE** | Review readability, naming, mutability, dan kualitas kode umum. |
| `frontend-patterns` | **OPSIONAL** | Menulis React/Next.js atau state management frontend. Razor Bot saat ini memakai vanilla JS. |
| `frontend-design` | **SITUASIONAL** | Menentukan arah visual baru sebelum implementasi UI. |
| `frontend-a11y` | **OPSIONAL** | Accessibility khusus komponen React/Next.js. |
| `accessibility` | **SITUASIONAL** | Audit WCAG, semantic HTML, keyboard, ARIA, dan screen reader. |
| `seo` | **OPSIONAL** | Mengoptimalkan halaman publik untuk search engine. Dashboard lokal biasanya tidak memerlukannya. |
| `api-design` | **SITUASIONAL** | Mendesain endpoint, status code, pagination, error response, atau versioning. |
| `api-connector-builder` | **SITUASIONAL** | Menambah provider/API baru dengan mengikuti pola integrasi repository. |
| `vite-patterns` | **OPSIONAL** | Repository memakai Vite atau membutuhkan bundler/HMR. Stack saat ini tidak bergantung pada Vite. |
| `mcp-server-patterns` | **OPSIONAL** | Membuat MCP server, tool, resource, atau transport MCP. |

## Database, Infrastructure, dan Deployment

| Skill | Prioritas | Pakai ketika |
|---|---|---|
| `database-migrations` | **SITUASIONAL** | Mengubah schema/data SQLite atau database lain dengan migration dan rollback. |
| `docker-patterns` | **SITUASIONAL** | Membuat Dockerfile, Compose, volume, network, atau local environment. |
| `deployment-patterns` | **SITUASIONAL** | Menyiapkan CI/CD, health check, rollback, atau release production. |
| `redis-patterns` | **OPSIONAL** | Redis benar-benar ditambahkan untuk cache, lock, rate limit, atau pub/sub. |
| `production-audit` | **SITUASIONAL** | Menjawab risiko production, release readiness, dan failure mode sebelum launch. |
| `dashboard-builder` | **OPSIONAL** | Membuat dashboard observability seperti Grafana/SigNoz, bukan dashboard produk biasa. |

## Crypto dan Prediction Market

| Skill | Prioritas | Pakai ketika |
|---|---|---|
| `nodejs-keccak256` | **SITUASIONAL** | Menghitung selector, signature, address, atau hash Ethereum di Node.js. |
| `defi-amm-security` | **OPSIONAL** | Menulis atau mereview kontrak AMM, swap, pool, oracle, dan slippage. |
| `prediction-market-oracle-research` | **SITUASIONAL** | Menilai prediction market sebagai sumber data atau signal produk. |
| `prediction-market-risk-review` | **CORE** | Mereview risiko data, execution, privacy, compliance, dan auth prediction market. |
| `ito-basket-compare` | **OPSIONAL** | Membandingkan basket prediction market dengan portfolio/watchlist. |
| `ito-compute` | **OPSIONAL** | Menggunakan Itô untuk inventory GPU atau RFQ compute. |
| `ito-data-atlas-agent` | **OPSIONAL** | Mendesain background agent untuk market discovery dan basket research. |
| `ito-market-intelligence` | **SITUASIONAL** | Riset venue, event, liquidity, underlier, dan news prediction market. |

## Performance dan Biaya LLM

| Skill | Prioritas | Pakai ketika |
|---|---|---|
| `latency-critical-systems` | **CORE** | Mengubah realtime stream, orderbook, queue, cache, freshness, atau p95 latency. |
| `cost-aware-llm-pipeline` | **SITUASIONAL** | Mengoptimalkan model routing, token usage, retry, caching, atau budget LLM. |

## Testing dan QA

| Skill | Prioritas | Pakai ketika | Catatan |
|---|---|---|---|
| `test-driven-development` | **CORE** | Menambah fitur atau memperbaiki bug dengan test yang gagal lebih dulu. | Default untuk perubahan behavior. |
| `tdd-workflow` | **SITUASIONAL** | Membutuhkan workflow TDD lengkap beserta target coverage/integration/E2E. | Lebih luas daripada skill test-driven dasar. |
| `verification-before-completion` | **CORE** | Akan menyatakan pekerjaan selesai atau test lulus. | Evidence gate setelah `verification-loop`, bukan pengganti test runner. |
| `e2e-testing` | **SITUASIONAL** | Menulis atau merawat suite Playwright end-to-end. |
| `webapp-testing` | **CORE** | Berinteraksi dengan aplikasi lokal dan memeriksa behavior/browser log. |
| `browser-qa` | **SITUASIONAL** | Verifikasi visual dan flow UI setelah aplikasi berjalan. |

## Security dan Safety

| Skill | Prioritas | Pakai ketika |
|---|---|---|
| `safety-guard` | **CORE** | Ada operasi destruktif, production system, database nyata, atau agent otonom. |
| `security-bounty-hunter` | **OPSIONAL** | Mencari vulnerability yang remotely exploitable dan layak laporan bounty. |
| `security-scan` | **SITUASIONAL** | Audit konfigurasi agent, MCP, hooks, permission, dan injection risk. |

## Research dan Dokumentasi

| Skill | Prioritas | Pakai ketika |
|---|---|---|
| `deep-research` | **SITUASIONAL** | Membutuhkan riset multi-sumber dengan bukti dan sitasi. |
| `exa-search` | **OPSIONAL** | Exa tersedia dan dibutuhkan untuk neural web/code/company search. |
| `search-first` | **SITUASIONAL** | Perlu mencari library, tool, atau pola existing sebelum menulis custom code. |
| `research-ops` | **SITUASIONAL** | Membutuhkan current-state research yang evidence-first. |
| `documentation-lookup` | **CORE** | Membutuhkan API/library docs terbaru, bukan mengandalkan ingatan model. |
| `doc-coauthoring` | **SITUASIONAL** | Menulis spec, proposal, guide, atau dokumentasi secara terstruktur. |

## Planning dan Agent Workflow

| Skill | Prioritas | Pakai ketika | Catatan |
|---|---|---|---|
| `brainstorming` | **SITUASIONAL** | Requirement atau desain behavior belum matang. | Gunakan sebelum implementasi kreatif/baru. |
| `writing-plans` | **SITUASIONAL** | Scope sudah jelas tetapi butuh implementation plan bertahap. |
| `executing-plans` | **SITUASIONAL** | Menjalankan plan tertulis dengan checkpoint. |
| `subagent-driven-development` | **SITUASIONAL** | Plan terdiri dari task terpisah yang cocok dikerjakan agent berbeda. |
| `dispatching-parallel-agents` | **SITUASIONAL** | Ada minimal dua pekerjaan independen tanpa shared state. |
| `requesting-code-review` | **CORE** | Fitur/fix selesai dan perlu review correctness sebelum delivery. |
| `systematic-debugging` | **CORE** | Ada bug, test failure, atau behavior aneh yang belum diketahui root cause-nya. |
| `gateguard` | **OPSIONAL** | Ingin memaksa investigasi fakta sebelum agent boleh mengedit. |

## Audit, Git, dan Maintenance

| Skill | Prioritas | Pakai ketika |
|---|---|---|
| `repo-scan` | **OPSIONAL** | Membutuhkan inventaris dan klasifikasi seluruh source asset repository. |
| `git-workflow` | **SITUASIONAL** | Menentukan branch, merge/rebase, conflict resolution, atau convention commit. |
| `finishing-a-development-branch` | **SITUASIONAL** | Implementasi selesai dan perlu menentukan integrasi/merge/cleanup branch. |
| `context-budget` | **OPSIONAL** | Mengaudit context bloat dari skill, agent, MCP, dan rule. |
| `strategic-compact` | **OPSIONAL** | Sesi panjang membutuhkan compaction pada batas fase yang logis. |
| `growth-log` | **OPSIONAL** | Ingin mencatat pelajaran reusable setelah task kompleks atau kegagalan. |

## Design Tambahan

| Skill | Prioritas | Pakai ketika |
|---|---|---|
| `design-system` | **SITUASIONAL** | Membuat atau mengaudit token, component consistency, dan visual system. |
| `make-interfaces-feel-better` | **SITUASIONAL** | Memoles spacing, typography, border, motion, hit area, dan interaction state. |
| `motion-ui` | **OPSIONAL** | Mengimplementasikan animation/motion system, terutama React/Next.js. |

## Product dan Decision Making

| Skill | Prioritas | Pakai ketika |
|---|---|---|
| `product-lens` | **SITUASIONAL** | Memastikan alasan dan value sebuah fitur sebelum dibangun. |
| `council` | **OPSIONAL** | Ada beberapa pilihan valid dan butuh structured disagreement. |

---

# Template Meminta Agent Memakai Skill

Gunakan template ini bila ingin skill benar-benar dipertimbangkan:

```text
Sebelum mengerjakan tugas ini:

1. Pilih 1 skill utama dan maksimal 2 skill pendamping dari SKILLS_GUIDE.md.
2. Jika skill punya versi lokal, baca `.agents/skills/<nama-folder>/SKILL.md` meskipun nama yang sama juga ada di registry.
3. Jika tidak ada versi lokal tetapi skill terdaftar di tool `skill`, invoke skill tersebut.
4. Jangan memakai skill yang tidak relevan atau saling bertentangan.
5. Sebutkan secara singkat skill yang dipilih, kerjakan tugas, lalu jalankan check proyek yang relevan sebelum mengklaim selesai. Skill verification tidak menghitung kuota pendamping.

Tugas: [tulis tugas di sini]
```

Untuk memaksa pilihan tertentu:

```text
Gunakan `systematic-debugging` sebagai skill utama dan `test-driven-development` sebagai pendamping. Cari root cause, buat regression test, implementasikan fix, jalankan `npm test` dan `npm run check`, lalu pastikan output terbaru mendukung klaim selesai.
```

# Catatan Pemeliharaan

- Jangan menulis jumlah total skill registry global karena bisa berubah. Untuk skill lokal, jumlah sudah distempel di heading katalog.
- Tambahkan skill baru ke Quick Picker hanya jika sering dipakai.
- Jika dua skill melakukan hal yang hampir sama, tulis satu sebagai default dan satu sebagai alternatif langsung di Quick Picker atau Shortlist, bukan hanya di katalog.
- Path skill global berbeda antar instalasi; gunakan nama registry, bukan path home yang hard-coded.
- Guardrail project tidak diduplikasi di sini. Lihat `.agents/AGENTS.md` sebagai sumber aturan proyek.
