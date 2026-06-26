const https = require('https');

https.get('https://gamma-api.polymarket.com/events?series_slug=btc-up-or-down-5m&active=true&closed=false&limit=1', (res) => {
  let data = '';
  res.on('data', chunk => data += chunk);
  res.on('end', () => console.log(JSON.stringify(JSON.parse(data), null, 2)));
});
