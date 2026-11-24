// Local test server for the real Code.gs running against mocked Google services.
const http = require('node:http');
const { createBackend } = require('./gas_harness.cjs');
const backend = createBackend(); backend.setup();
const server = http.createServer((req, res) => {
    let raw = ''; req.on('data', chunk => { raw += chunk; });
    req.on('end', () => {
        try {
            const url = new URL(req.url, 'http://localhost');
            let result;
            if (req.method === 'POST') {
                const body = JSON.parse(raw); result = backend.api(body.action, body.data, body.token, body.requestId);
            } else result = backend.get(url.searchParams.get('action'));
            res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(result));
        } catch (error) { res.writeHead(500, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ status: 'error', message: error.message })); }
    });
});
server.listen(0, '127.0.0.1', () => process.stdout.write(JSON.stringify({ port: server.address().port }) + '\n'));
process.on('SIGTERM', () => server.close());
