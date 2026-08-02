import test from "node:test";
import assert from "node:assert/strict";

import {
  escapeHtml,
  formatLimitedRichText,
  formatStoredRichText,
  polymarketEventUrl,
  sanitizeHttpUrl,
} from "../public/render-safety.js";

test("assistant rich text escapes model HTML before applying allowed markup", () => {
  const rendered = formatLimitedRichText('<img src=x onerror="alert(1)"> **safe** _note_ `code` 63%');

  assert.equal(rendered.includes("<img"), false);
  assert.equal(rendered.includes("onerror=\""), false);
  assert.match(rendered, /&lt;img src=x onerror=&quot;alert\(1\)&quot;&gt;/);
  assert.match(rendered, /<strong>safe<\/strong>/);
  assert.match(rendered, /<em>note<\/em>/);
  assert.match(rendered, /<code>code<\/code>/);
  assert.match(rendered, /63%/);
});

test("stored reflection markup remains limited after escaping external HTML", () => {
  const rendered = formatStoredRichText('**Lesson**\\n<img src=x onerror="alert(1)">');

  assert.match(rendered, /^<strong>Lesson<\/strong><br>/);
  assert.equal(rendered.includes("<img"), false);
  assert.match(rendered, /&lt;img src=x onerror=&quot;alert\(1\)&quot;&gt;/);
});

test("third-party market slugs become encoded HTTPS Polymarket URLs", () => {
  assert.equal(
    polymarketEventUrl('safe" onclick="alert(1)/javascript:payload'),
    "https://polymarket.com/event/safe%22%20onclick%3D%22alert(1)%2Fjavascript%3Apayload",
  );
  assert.equal(polymarketEventUrl(""), null);
});

test("attribute escaping neutralizes quotes and javascript-like URLs are rejected", () => {
  assert.equal(escapeHtml('market" onmouseover="alert(1)'), "market&quot; onmouseover=&quot;alert(1)");
  assert.equal(sanitizeHttpUrl("javascript:alert(1)"), null);
  assert.equal(sanitizeHttpUrl('https://polymarket.com/event/a"b'), null);
  assert.equal(sanitizeHttpUrl("https://polymarket.com/event/safe"), "https://polymarket.com/event/safe");
});
