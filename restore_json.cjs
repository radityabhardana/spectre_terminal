const fs = require('fs');

let content = fs.readFileSync('c:/ALL/Razor Bot/src/qwen.js', 'utf8');

content = content.replace(
  /temperature: 0\.2,\n    max_tokens: roleMaxTokens\("fast"\),\n  \};/g,
  `temperature: 0.2,\n    max_tokens: roleMaxTokens("fast"),\n    response_format: { type: "json_object" },\n  };`
);

content = content.replace(
  /temperature: 0\.2,\n    max_tokens: roleMaxTokens\("analyst"\),\n  \};/g,
  `temperature: 0.2,\n    max_tokens: roleMaxTokens("analyst"),\n    response_format: { type: "json_object" },\n  };`
);

content = content.replace(
  /temperature: 0\.1,\n    max_tokens: roleMaxTokens\("final"\),\n  \};/g,
  `temperature: 0.1,\n    max_tokens: roleMaxTokens("final"),\n    response_format: { type: "json_object" },\n  };`
);

fs.writeFileSync('c:/ALL/Razor Bot/src/qwen.js', content, 'utf8');
console.log('Restored response_format for Qwen');
