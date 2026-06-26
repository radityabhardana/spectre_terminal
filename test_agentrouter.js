const apiKey = "sk-c9bRJe1xgwPWXmnmqDWFyRZGYsh7BpDoQCmIHSyJ4ZFAbVsC";
const url = "https://agentrouter.org/v1/chat/completions";

async function test() {
  const payload = {
    model: "claude-sonnet-4-6",
    messages: [{ role: "user", content: "Hello" }]
  };
  
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${apiKey}`
    },
    body: JSON.stringify(payload)
  });
  
  const text = await res.text();
  console.log("Status:", res.status);
  console.log("Response:", text);
}

test();
