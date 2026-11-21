import http from 'node:http';
const req = http.get({ socketPath: process.env.BRIDGE_SOCKET ?? '/run/neo/ai.sock', path: '/healthz' }, res => {
  res.resume(); process.exitCode = res.statusCode === 200 ? 0 : 1;
});
req.setTimeout(1500, () => { process.exitCode = 1; req.destroy(); });
req.on('error', () => { process.exitCode = 1; });
