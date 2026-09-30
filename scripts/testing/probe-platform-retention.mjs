// Socket-level test probe for the platform retention route, not an engine client.
let input = '';
for await (const chunk of process.stdin) input += chunk;
const { endpoint, token } = JSON.parse(input);
const url = new URL(endpoint);
if (url.hostname !== '127.0.0.1' || url.protocol !== 'http:' || url.pathname !== '/internal/deletion/retention') {
  throw new Error('Retention probe accepts only the local platform retention route');
}
const post = (authorization) => fetch(url, { method: 'POST', headers: authorization ? { authorization } : {} });
const missing = await post();
const wrong = await post('Bearer wrong');
const accepted = await post(`Bearer ${token}`);
console.log(JSON.stringify({ missing: missing.status, wrong: wrong.status, accepted: accepted.status, body: await accepted.json() }));
