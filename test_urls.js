const apiKey = "sk-c9bRJe1xgwPWXmnmqDWFyRZGYsh7BpDoQCmIHSyJ4ZFAbVsC";

const urls = [
  "https://api.agentrouter.com/v1/chat/completions",
  "https://agentrouter.com/v1/chat/completions",
  "https://api.agentrouter.org/v1/chat/completions",
  "https://agentrouter.org/v1/chat/completions"
];

async function test() {
  const payload = {
    model: "claude-sonnet-4-6",
    messages: [{ role: "user", content: "Hello" }]
  };

  for (const url of urls) {
    console.log("Testing:", url);
    try {
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
      console.log("Response:", text.slice(0, 150));
      console.log("----------");
    } catch (e) {
      console.log("Error:", e.message);
      console.log("----------");
    }
  }
}

test();
