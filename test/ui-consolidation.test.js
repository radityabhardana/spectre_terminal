import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import assert from "node:assert/strict";
const pub = join(dirname(fileURLToPath(import.meta.url)), "..", "public");

const html = readFileSync(join(pub, "index.html"), "utf8");
const appJs = readFileSync(join(pub, "app.js"), "utf8");

test("terminal-shell.css is the single stylesheet (styles-v2 removed)", () => {
  assert.equal(existsSync(join(pub, "styles-v2.css")), false, "styles-v2.css must be deleted");
  assert.equal(html.includes("styles-v2.css"), false, "no link/styles reference to styles-v2.css");
  const links = [...html.matchAll(/<link[^>]+rel="stylesheet"[^>]*>/g)]
    .map((m) => m[0])
    .filter((link) => /href="\//.test(link));
  assert.equal(links.length, 1, `expected exactly 1 local stylesheet link, got ${links.length}`);
  assert.match(links[0], /terminal-shell\.css/);
});

test("legacy theme system fully removed", () => {
  for (const s of ["razorbot_mode", "themePanelModal", "btnThemePanelTrigger", "theme-grid-item"]) {
    assert.equal(html.includes(s), false, `index.html must not contain ${s}`);
    assert.equal(appJs.includes(s), false, `app.js must not contain ${s}`);
  }
  for (const s of ["applyTheme(", "currentTheme", 'localStorage.getItem("theme")', 'setAttribute("data-theme"']) {
    assert.equal(appJs.includes(s), false, `app.js must not contain ${s}`);
  }
});

test("HTML contains no embedded legacy styles or inline hover handlers", () => {
  assert.equal(html.includes("<style"), false, "no embedded style blocks allowed");
  assert.equal(html.includes("</style>"), false);
  assert.equal(html.includes("onmouseover="), false);
  assert.equal(html.includes("onmouseout="), false);
});

test("fixed dark + geist appearance, no flashlight override script", () => {
  assert.match(html, /<html[^>]+data-mode="dark"/);
  assert.match(html, /<html[^>]+data-font="geist"/);
  assert.equal(html.includes("documentElement.setAttribute('data-mode'"), false, "no flashlight localStorage script");
});
