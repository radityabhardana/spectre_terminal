import test from "node:test";
import assert from "node:assert/strict";

import { config, assertQwenConfig } from "../src/config.js";
import {
  askQwenShortCondition,
  checkAiProviderConnection,
  requestAiText,
  resetProviderConnectionCache,
} from "../src/qwen.js";

const CONFIG_FIELDS = [
  "aiProviderName",
  "qwenApiKey",
  "qwenBaseUrl",
  "qwenBullModel",
  "qwenBearModel",
  "qwenRiskManagerModel",
  "qwenFallbackModel",
  "qwenShortModel",
  "qwenEvaluatorModel",
  "qwenScoutModel",
  "qwenEventAnalystModel",
  "qwenEventFinalModel",
  "qwenShortMaxTokens",
];

async function withAiConfig(overrides, task) {
  const saved = {};
  for (const key of CONFIG_FIELDS) saved[key] = config[key];
  Object.assign(config, overrides);
  resetProviderConnectionCache();
  try {
    return await task();
  } finally {
    Object.assign(config, saved);
    resetProviderConnectionCache();
  }
}

// Cache-busted import so each scenario re-reads process.env in src/config.js.
async function importConfigWithEnv(caseName, env) {
  const keys = ["NINEROUTER_API_KEY", "QWEN_EVALUATOR_MODEL", "QWEN_FINAL_MODEL", "QWEN_MODEL"];
  const saved = {};
  for (const key of keys) saved[key] = process.env[key];
  for (const [key, value] of Object.entries(env)) process.env[key] = value;
  try {
    const module = await import(`../src/config.js?evaluator=${caseName}`);
    return module.config;
  } finally {
    for (const key of keys) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  }
}

function jsonResponse(body) {
  return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
}

function mockModelsEndpoint(t, ids) {
  t.mock.method(globalThis, "fetch", async () => jsonResponse({ data: ids.map((id) => ({ id })) }));
}

const CONNECTION_OVERRIDES = {
  aiProviderName: "9router",
  qwenApiKey: "test-key",
  qwenBaseUrl: "http://mock.local/v1",
  qwenBullModel: "model-a",
  qwenBearModel: "model-a",
  qwenRiskManagerModel: "model-a",
  qwenFallbackModel: "model-a",
  qwenShortModel: "model-a",
  qwenEvaluatorModel: "model-a",
  qwenScoutModel: "model-a",
  qwenEventAnalystModel: "model-a",
  qwenEventFinalModel: "model-a",
};

test("QWEN_EVALUATOR_MODEL env value wins when set", async () => {
  const fresh = await importConfigWithEnv("explicit", {
    NINEROUTER_API_KEY: "test-key",
    QWEN_EVALUATOR_MODEL: "eval-model-x",
  });
  assert.equal(fresh.qwenEvaluatorModel, "eval-model-x");
});

test("evaluator model falls back to QWEN_FINAL_MODEL when its own env is empty", async () => {
  const fresh = await importConfigWithEnv("final", {
    NINEROUTER_API_KEY: "test-key",
    QWEN_EVALUATOR_MODEL: "",
    QWEN_FINAL_MODEL: "final-model-x",
    QWEN_MODEL: "",
  });
  assert.equal(fresh.qwenEvaluatorModel, "final-model-x");
});

test("evaluator model falls back to the default final model when no env override is set", async () => {
  const fresh = await importConfigWithEnv("default", {
    NINEROUTER_API_KEY: "test-key",
    QWEN_EVALUATOR_MODEL: "",
    QWEN_FINAL_MODEL: "",
    QWEN_MODEL: "",
  });
  assert.equal(fresh.qwenEvaluatorModel, "alims-intl/deepseek-v4-pro-0813");
});

test("assertQwenConfig rejects an empty evaluator model", async () => {
  await withAiConfig({ qwenApiKey: "test-key", qwenEvaluatorModel: "  " }, () => {
    assert.throws(() => assertQwenConfig(), /model IDs/i);
  });
});

test("application fallback is skipped when the fallback model equals the primary model", async (t) => {
  const fetchMock = t.mock.method(globalThis, "fetch", async () => new Response(
    JSON.stringify({ error: { message: "Invalid JSON request" } }),
    { status: 400, headers: { "content-type": "application/json" } },
  ));

  await withAiConfig({ qwenApiKey: "test-key", qwenBaseUrl: "http://mock.local/v1" }, async () => {
    await assert.rejects(
      requestAiText(
        {
          model: "primary-model",
          messages: [{ role: "user", content: "Analyze" }],
          response_format: { type: "json_object" },
        },
        { fallbackModel: "primary-model" },
      ),
      /HTTP 400/,
    );
  });

  assert.equal(fetchMock.mock.callCount(), 1);
});

test("application fallback is skipped when the fallback model only differs by whitespace", async (t) => {
  const fetchMock = t.mock.method(globalThis, "fetch", async () => new Response(
    JSON.stringify({ error: { message: "Invalid JSON request" } }),
    { status: 400, headers: { "content-type": "application/json" } },
  ));

  await withAiConfig({ qwenApiKey: "test-key", qwenBaseUrl: "http://mock.local/v1" }, async () => {
    await assert.rejects(
      requestAiText(
        {
          model: "primary-model",
          messages: [{ role: "user", content: "Analyze" }],
          response_format: { type: "json_object" },
        },
        { fallbackModel: "  primary-model  " },
      ),
      /HTTP 400/,
    );
  });

  assert.equal(fetchMock.mock.callCount(), 1);
});

test("application fallback still occurs when the fallback model ID differs", async (t) => {
  const responses = [
    { model: "primary-model", content: '{"condition":' },
    { model: "fallback-model", content: '{"condition":"CHOPPY"}' },
  ];
  const fetchMock = t.mock.method(globalThis, "fetch", async () => {
    const response = responses.shift();
    return jsonResponse({ model: response.model, choices: [{ message: { content: response.content } }] });
  });

  const result = await withAiConfig({ qwenApiKey: "test-key", qwenBaseUrl: "http://mock.local/v1" }, () =>
    requestAiText(
      {
        model: "primary-model",
        messages: [{ role: "user", content: "Analyze" }],
        response_format: { type: "json_object" },
      },
      { fallbackModel: "fallback-model" },
    ));

  assert.equal(result.text, '{"condition":"CHOPPY"}');
  assert.equal(result.fallbackFrom, "primary-model");
  assert.equal(fetchMock.mock.callCount(), 2);
});

test("9Router model listed in /models is verified", async (t) => {
  mockModelsEndpoint(t, ["model-a", "other-model"]);
  const result = await withAiConfig(CONNECTION_OVERRIDES, () => checkAiProviderConnection());

  assert.equal(result.reachable, true);
  assert.deepEqual(result.verifiedModels, ["model-a"]);
  assert.deepEqual(result.unverifiedModels, []);
  assert.deepEqual(result.missingModels, []);
  assert.equal(result.modelsAvailable, true);
  assert.deepEqual(result.configuredModels, ["model-a"]);
});

test("9Router model absent from a non-empty /models list is unverified, not missing", async (t) => {
  mockModelsEndpoint(t, ["other-model"]);
  const result = await withAiConfig(CONNECTION_OVERRIDES, () => checkAiProviderConnection());

  assert.equal(result.reachable, true);
  assert.deepEqual(result.verifiedModels, []);
  assert.deepEqual(result.unverifiedModels, ["model-a"]);
  assert.deepEqual(result.missingModels, []);
  assert.equal(result.modelsAvailable, true);
});

test("9Router model stays unverified when /models returns an empty list", async (t) => {
  mockModelsEndpoint(t, []);
  const result = await withAiConfig(CONNECTION_OVERRIDES, () => checkAiProviderConnection());

  assert.equal(result.reachable, true);
  assert.deepEqual(result.verifiedModels, []);
  assert.deepEqual(result.unverifiedModels, ["model-a"]);
  assert.deepEqual(result.missingModels, []);
  assert.equal(result.modelsAvailable, true);
});

test("non-9Router model absent from /models is missing", async (t) => {
  mockModelsEndpoint(t, ["other-model"]);
  const result = await withAiConfig({ ...CONNECTION_OVERRIDES, aiProviderName: "openrouter" }, () =>
    checkAiProviderConnection());

  assert.equal(result.reachable, true);
  assert.deepEqual(result.verifiedModels, []);
  assert.deepEqual(result.unverifiedModels, []);
  assert.deepEqual(result.missingModels, ["model-a"]);
  assert.equal(result.modelsAvailable, false);
});

async function captureShortConditionPayload(t, maxTokens) {
  let captured;
  t.mock.method(globalThis, "fetch", async (url, options) => {
    captured = JSON.parse(options.body);
    return jsonResponse({
      model: captured.model,
      choices: [{ message: { content: '{"reason":"x","key_signals":{"depth_verdict":"d"},"risk_warning":"y"}' } }],
    });
  });

  const result = await withAiConfig({
    qwenApiKey: "test-key",
    qwenBaseUrl: "http://mock.local/v1",
    qwenShortModel: "short-model",
    qwenShortMaxTokens: maxTokens,
  }, () => askQwenShortCondition({ marketQuestion: "", deterministic: { recommendation: "PLAY" } }));

  assert.equal(result.reason, "x");
  return captured;
}

test("short AI request caps max_tokens at 1500", async (t) => {
  const payload = await captureShortConditionPayload(t, 4000);
  assert.equal(payload.max_tokens, 1500);
});

test("short AI request keeps a smaller configured max_tokens", async (t) => {
  const payload = await captureShortConditionPayload(t, 500);
  assert.equal(payload.max_tokens, 500);
});
