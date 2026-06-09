# MVPM Polymarket Analyzer — Design Document

## 🎯 Design Vision

**Konsep: Futuristic Finance Terminal**

Mengubah tampilan website menjadi trading terminal profesional yang terinspirasi dari Bloomberg Terminal, TradingView, dan platform DeFi modern. Interface harus terasa seperti cockpit command center untuk analisis prediction market — gelap, presisi, dan data-driven.

---

## 🎨 Design System

### Color Palette (Dark Mode Only)

```
Background Layers:
  --bg-base:       #06080c       ← deepest background (near-black blue)
  --bg-surface:    #0d1117       ← panel backgrounds (GitHub dark style)
  --bg-elevated:   #161b22       ← elevated cards, modals
  --bg-overlay:    #1c2128       ← hover states, tooltips

Border & Lines:
  --border:        #21262d       ← default borders
  --border-bright: #30363d       ← emphasized borders
  --border-focus:  #58a6ff       ← focus rings

Text:
  --text-primary:  #e6edf3       ← primary text
  --text-secondary:#8b949e       ← secondary / muted
  --text-tertiary: #484f58       ← disabled / hints
  --text-inverse:  #0d1117       ← text on bright backgrounds

Accent Colors (Neon Trading Theme):
  --neon-green:    #00ff88       ← primary accent (buy/positive)
  --neon-blue:     #58a6ff       ← links, interactive elements
  --neon-cyan:     #00d4ff       ← secondary highlights
  --neon-red:      #ff4757       ← sell/negative/errors
  --neon-amber:    #ffb800       ← warnings, pending
  --neon-purple:   #bc8cff       ← AI/Qwen indicators

Glow Effects:
  --glow-green:    0 0 20px rgba(0, 255, 136, 0.15)
  --glow-blue:     0 0 20px rgba(88, 166, 255, 0.15)
  --glow-red:      0 0 20px rgba(255, 71, 87, 0.15)
```

### Typography

```
Font Stack:
  Headings:    "JetBrains Mono", "Fira Code", monospace
  Body:        "Inter", -apple-system, system-ui, sans-serif
  Code/Data:   "JetBrains Mono", "Cascadia Code", "SF Mono", monospace

Sizes:
  --text-xs:   11px    ← labels, timestamps, metadata
  --text-sm:   12px    ← secondary info, status badges
  --text-base: 13px    ← body text, data cells
  --text-md:   14px    ← input fields, buttons
  --text-lg:   16px    ← section headers
  --text-xl:   20px    ← panel titles
  --text-2xl:  24px    ← main heading

Weights:
  Normal:  400
  Medium:  500
  Bold:    700
  Black:   900 (for branding only)
```

### Spacing & Sizing

```
Border Radius:
  --radius-sm:  4px    ← small buttons, tags
  --radius-md:  6px    ← inputs, cards
  --radius-lg:  8px    ← panels, modals
  --radius-xl:  12px   ← main containers

Spacing Scale:
  4px → 8px → 12px → 16px → 20px → 24px → 32px
```

---

## 📐 Layout Architecture

### Overview: 3-Zone Terminal Layout

```
┌──────────────────────────────────────────────────────────────┐
│  HEADER BAR (fixed, 48px)                                    │
│  [Logo] MVPM Terminal    [Status Indicators]   [System Info]  │
├──────────┬───────────────────────────────────────────────────┤
│          │                                                   │
│  SIDEBAR │   MAIN WORKSPACE                                  │
│  (300px) │                                                   │
│          │  ┌─────────────────────────────────────────────┐  │
│  Command │  │ TAB BAR (output tabs)                       │  │
│  Panel   │  ├─────────────────────────┬───────────────────┤  │
│          │  │                         │                   │  │
│  • Mode  │  │  CONSOLE OUTPUT         │  MARKET EMBED     │  │
│  • Input │  │  (scrollable feed)      │  (Polymarket      │  │
│  • Quick │  │                         │   iframe +        │  │
│    Cmds  │  │                         │   market data)    │  │
│  • Guard │  │                         │                   │  │
│    Rail  │  │                         │                   │  │
│          │  └─────────────────────────┴───────────────────┘  │
├──────────┴───────────────────────────────────────────────────┤
│  STATUS BAR (fixed, 28px)                                     │
│  [●] Connected  │  Engine v2.x  │  Qwen: Active  │  Latency  │
└──────────────────────────────────────────────────────────────┘
```

### Zone Details

#### 1. Header Bar (48px)
- **Kiri:** Logo SVG + "MVPM Terminal" dalam monospace font
- **Tengah:** Live clock (format trading: `15:42:07 WIB`)
- **Kanan:** Notification bell, connection status dot (pulsing green)
- **Style:** Solid dark background, 1px bottom border dengan subtle glow

#### 2. Sidebar — Command Panel (300px fixed)
- **Compact & dense** — setiap pixel bernilai
- **Sections stacked vertically:**
  1. **Quick Commands** (4 buttons dalam 2x2 grid)
     - Volume, Liquidity, New, Ending
     - Setiap button punya ikon kecil + label
     - Active state: neon green left-border glow
  2. **Mode Selector** — styled dropdown atau segmented control
  3. **Input Area** — monospace textarea dengan:
     - Line numbers di kiri (opsional)
     - Run button: circle button dengan glow effect
     - Cancel button: saat loading
  4. **Guard Rail Card** — mini dashboard:
     - Status dots (green/amber/red)
     - Key-value pairs dalam grid
     - Command hints dalam code blocks

#### 3. Main Workspace
- **Tab Bar:** Horizontal scrollable tabs, styled seperti browser tabs
  - Active tab: bright bottom border
  - Hover: subtle glow
- **Console Output:** Terminal-style feed
  - Setiap message adalah card dengan:
    - Header: role label + timestamp
    - Body: monospace pre-formatted text
    - Optional: action buttons grid di bawah
  - User messages: left-aligned, subtle blue tint
  - Bot responses: full-width, dark background
  - Errors: red left-border accent
- **Market Embed Panel:** Polymarket iframe
  - Header dengan market title + "Open in Polymarket" link
  - Placeholder state saat belum ada market

#### 4. Status Bar (NEW — 28px, bottom)
- Fixed di bawah, spanning full width
- Content: Connection status, engine version, Qwen status, response time
- Style: Very subtle background, small text, monospace

---

## 🧩 Component Specifications

### 1. Status Badge / Pill
```
┌─────────────────┐
│ ● Label Text    │
└─────────────────┘

Variants:
  • online  → green dot + green border glow
  • warning → amber dot + amber border
  • error   → red dot + red border
  • offline → gray dot + gray border
  • ai      → purple dot + purple border (for Qwen)

Size: height 24px, padding 4px 10px
Font: 11px, uppercase, letter-spacing 0.05em
Border: 1px solid with 10% opacity of accent color
Background: 5% opacity of accent color
Border-radius: 999px
```

### 2. Command Button (Preset Grid)
```
┌──────────────────┐
│  ▊ Volume        │  ← neon-green left-border when active
│                  │
└──────────────────┘

States:
  Default:  bg-surface, border subtle
  Hover:    border brightens, subtle glow
  Active:   left-border 2px neon-green, text brighten
  Disabled: opacity 0.4

Size: min-height 40px
Font: 13px medium
Transition: all 150ms ease
```

### 3. Moon Button (Run/Cancel)
```
         ╭───╮
        │ ◐  │    ← Crescent moon shape
        │Run │
         ╰───╯

States:
  Idle:     neon-green glow, crescent moon icon
  Running:  Transform to X icon, red glow, "Cancel" label
  Cooldown: Spinning ring, amber glow, countdown timer "3s"

Size: 48x48px circle
Position: absolute, bottom-right of textarea
```

### 4. Message Card
```
┌─ RESULT ──────────────────── 15:42 ─┐
│                                      │
│  [monospace content here]            │
│  Market data, analysis results...    │
│                                      │
│  ┌──────┐ ┌──────────┐ ┌──────────┐ │
│  │ Btn1 │ │   Btn2   │ │   Btn3   │ │
│  └──────┘ └──────────┘ └──────────┘ │
└──────────────────────────────────────┘

Variants:
  user:      subtle cyan/blue left-border
  assistant: default dark card
  error:     red left-border + red-tinted background
```

### 5. Guard Rail Card
```
┌── ● Guard Rail ──────────────────────┐
│                                       │
│  Cooldown      Active                │
│  Qwen calls    Protected             │
│  Discovery     No Qwen               │
│                                       │
│  ┌─────────────────────────────────┐ │
│  │ /top3 <event>                   │ │
│  └─────────────────────────────────┘ │
│  ┌─────────────────────────────────┐ │
│  │ /analyzebest <event>            │ │
│  └─────────────────────────────────┘ │
└───────────────────────────────────────┘
```

### 6. Status Bar (NEW)
```
┌──────────────────────────────────────────────────────────────┐
│ ● Connected │ Engine: search-v2-discovery │ Qwen: ✓ │ 127ms │
└──────────────────────────────────────────────────────────────┘

Height: 28px
Font: 11px monospace
Background: bg-base with top-border
Separator: vertical 1px lines between items
```

---

## ✨ Micro-Animations & Effects

### Loading States
- **Spinner:** Rotating ring (2 colors: green + cyan), 900ms linear
- **Progress bar:** Indeterminate, thin line at top of console
- **Skeleton:** Pulse animation on placeholder content

### Interactive Feedback
- **Button hover:** translateY(-1px), border glow intensifies
- **Button click:** scale(0.97) for 100ms, then bounce back
- **Tab switch:** fade-in content with subtle translateY(4px → 0)
- **New message:** slide-in from bottom with opacity 0 → 1

### Ambient Effects
- **Scanline overlay:** Very subtle horizontal lines (opacity 0.02)
- **Grid background:** Faint dot-grid pattern on bg-base
- **Status dot pulse:** Gentle scale + opacity pulse every 2s
- **Neon glow:** Box-shadow pulses on active elements

### Transitions
```css
/* Standard transition */
transition: all 150ms ease;

/* Panel fade-in */
animation: fadeSlideUp 300ms ease-out;

/* Message appear */
animation: messageIn 200ms ease-out;

/* Status dot pulse */
animation: dotPulse 2s ease-in-out infinite;
```

---

## 📱 Responsive Breakpoints

### Desktop (> 1024px)
- Full 3-zone layout
- Sidebar 300px + Main workspace

### Tablet (768px - 1024px)
- Sidebar collapses to 260px
- Polymarket embed panel stacks below console
- Guard rail card hidden (accessible via toggle)

### Mobile (< 768px)
- Single column layout
- Sidebar becomes collapsible drawer (slide from left)
- Bottom sheet for command input
- Tabs become horizontal scrollable
- Status bar stacks into 2 rows

---

## 🔄 Changes from Current Design

### Removed
- ❌ Light mode support (dark mode only)
- ❌ Ambient grid background overlay
- ❌ Glassmorphism/frosted effects
- ❌ Outfit font (replaced with monospace-first)

### Added
- ✅ Status bar di bawah
- ✅ Live clock di header
- ✅ Scanline/grid ambient effect (very subtle)
- ✅ Neon glow effects pada active elements
- ✅ Left-border accent pada message cards
- ✅ Monospace-first typography
- ✅ Pulsing status dots

### Modified
- 🔄 Color palette → darker, more neon accents
- 🔄 Header → lebih compact (72px → 48px)
- 🔄 Status pills → redesigned badges
- 🔄 Button styles → more terminal/tech feel
- 🔄 Border radius → smaller, more angular
- 🔄 Message cards → cleaner with left-border accents
- 🔄 Typography → JetBrains Mono for headings

---

## 📁 Files to Modify

| File | Action | Description |
|------|--------|-------------|
| `public/styles.css` | **REWRITE** | Complete CSS overhaul dengan design system baru |
| `public/index.html` | **MODIFY** | Update structure: tambah status bar, clock, reorganize elements |
| `public/app.js` | **MODIFY** | Tambah live clock, hapus theme toggle logic, update status bar |
| `public/assets/` | **ADD** | Generate new SVG assets jika diperlukan |

---

## 🎯 Design Goals Checklist

- [ ] Terasa seperti professional trading terminal
- [ ] Dark mode only, no light theme
- [ ] Monospace-first typography untuk feel terminal
- [ ] Neon accent colors (green, cyan, blue) untuk highlights
- [ ] Compact dan dense — maksimalkan screen real estate
- [ ] Smooth micro-animations tanpa berlebihan
- [ ] Responsive di semua ukuran layar
- [ ] Status bar menampilkan system info realtime
- [ ] Console output terasa seperti terminal feed
- [ ] Setiap interaksi punya visual feedback
