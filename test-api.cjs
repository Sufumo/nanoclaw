const https = require('https');
const data = JSON.stringify({
  model: 'glm-5',
  max_tokens: 10,
  messages: [{role: 'user', content: 'Hi'}]
});
const options = {
  hostname: 'open.bigmodel.cn',
  port: 443,
  path: '/api/anthropic/v1/messages',
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'anthropic-version': '2023-06-01',
    'Authorization': 'Bearer xxx',
    'Content-Length': Buffer.byteLength(data)
  }
};
console.log('Making request to:', options.hostname + options.path);
const req = https.request(options, res => {
  console.log('Status:', res.statusCode);
  console.log('Headers:', JSON.stringify(res.headers, null, 2));
  let body = '';
  res.on('data', d => body += d);
  res.on('end', () => console.log('Body:', body.substring(0, 2000)));
});
req.on('error', e => console.error('Error:', e));
req.write(data);
req.end();
