const fs = require('fs');

let content = fs.readFileSync('c:/ALL/Razor Bot/src/qwen.js', 'utf8');

// 1. Replace callQwen
content = content.replace(
  /async function callQwen\(payload, signal = null\) \{/g,
  `async function callQwen(payload, baseUrl, apiKey, signal = null) {`
);
content = content.replace(
  /\`\$\{config\.qwenBaseUrl\}\/chat\/completions\`/g,
  `\`\${baseUrl}/chat/completions\``
);
content = content.replace(
  /\`Bearer \$\{config\.qwenApiKey\}\`/g,
  `\`Bearer \${apiKey}\``
);

// 2. Replace callQwenJson
content = content.replace(
  /async function callQwenJson\(payload, signal = null\) \{([\s\S]*?)json = await callQwen\(payload, signal\);([\s\S]*?)json = await callQwen\(fallbackPayload, signal\);/g,
  `async function callQwenJson(payload, baseUrl, apiKey, signal = null) {$1json = await callQwen(payload, baseUrl, apiKey, signal);$2json = await callQwen(fallbackPayload, baseUrl, apiKey, signal);`
);

// 3. Replace callRoleQwenJson
content = content.replace(
  /async function callRoleQwenJson\(payload, fallbackModel = "", signal = null\) \{([\s\S]*?)return await callQwenJson\(payload, signal\);([\s\S]*?)const fallback = await callQwenJson\(\{ \.\.\.payload, model: fallbackModel \}, signal\);/g,
  `async function callRoleQwenJson(payload, fallbackModel = "", baseUrl, apiKey, signal = null) {$1return await callQwenJson(payload, baseUrl, apiKey, signal);$2const fallback = await callQwenJson({ ...payload, model: fallbackModel }, baseUrl, apiKey, signal);`
);

// 4. In askQwen, update the 3 calls
content = content.replace(
  /const bullJson = await callRoleQwenJson\(bullPayload, config\.qwenAnalystModel, signal\);/g,
  `const bullJson = await callRoleQwenJson(bullPayload, config.qwenAnalystModel, config.qwenBaseUrl, config.qwenApiKey, signal);`
);
content = content.replace(
  /const bearJson = await callRoleQwenJson\(bearPayload, config\.qwenFinalModel, signal\);/g,
  `const bearJson = await callRoleQwenJson(bearPayload, config.qwenFinalModel, config.qwenBaseUrl, config.qwenApiKey, signal);`
);
content = content.replace(
  /const rmPayload = \{([\s\S]*?)model: config\.qwenFinalModel,/g,
  `const rmPayload = {$1model: config.customFinalModel || config.qwenFinalModel,`
);
content = content.replace(
  /const finalJson = await callRoleQwenJson\(rmPayload, config\.qwenAnalystModel, signal\);/g,
  `const finalJson = await callRoleQwenJson(rmPayload, config.qwenAnalystModel, config.customBaseUrl || config.qwenBaseUrl, config.customApiKey || config.qwenApiKey, signal);`
);

// 5. Update askQwenEvent's scout and analyst calls to use Qwen keys
content = content.replace(
  /const scoutJson = await callRoleQwenJson\(scoutPayload, config\.qwenAnalystModel, signal\);/g,
  `const scoutJson = await callRoleQwenJson(scoutPayload, config.qwenAnalystModel, config.qwenBaseUrl, config.qwenApiKey, signal);`
);
content = content.replace(
  /const analystJson = await callRoleQwenJson\(analystPayload, config\.qwenFinalModel, signal\);/g,
  `const analystJson = await callRoleQwenJson(analystPayload, config.qwenFinalModel, config.qwenBaseUrl, config.qwenApiKey, signal);`
);

fs.writeFileSync('c:/ALL/Razor Bot/src/qwen.js', content, 'utf8');
console.log('Successfully patched qwen.js for dual API');
