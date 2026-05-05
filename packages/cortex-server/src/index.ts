// @botcoin/cortex-server — standalone /v1/cortex/* HTTP process.
// Phase 5 deliverable. Stub.
import { createServer } from 'node:http';

const port = Number(process.env.PORT ?? 8081);
const server = createServer((req, res) => {
  if (req.url === '/healthz') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, phase: 'scaffold', service: 'cortex-server' }));
    return;
  }
  res.writeHead(503, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ ok: false, error: 'not-yet-implemented' }));
});

server.listen(port, () => {
  console.log(`[cortex-server] scaffold listening on :${port}`);
});
