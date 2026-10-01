// Dev-only static server: node tools/serve.js [port]
// Serves the project root, plus /harness = sidepanel.html with a chrome.* shim and the
// content script injected, so the UI can be exercised in a plain browser tab against the mock.
const http = require('http');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const port = Number(process.argv[2]) || 8765;
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.json': 'application/json' };

http
  .createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname === '/harness') {
      let html = fs.readFileSync(path.join(root, 'sidepanel.html'), 'utf8');
      html = html.replace('<link rel="stylesheet"', '<script src="/tests/chrome-shim.js"></script>\n  <link rel="stylesheet"');
      html = html.replace(
        '<script src="sidepanel.js"></script>',
        '<script src="sidepanel.js"></script>\n  <script src="instagram-api.js"></script>\n  <script src="scan-engine.js"></script>\n  <script src="content.js"></script>'
      );
      res.writeHead(200, { 'Content-Type': 'text/html' });
      return res.end(html.replace(/(src|href)="(?!\/|http)/g, '$1="/'));
    }
    const file = path.join(root, decodeURIComponent(url.pathname === '/' ? '/sidepanel.html' : url.pathname));
    if (!file.startsWith(root) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      res.writeHead(404);
      return res.end('not found');
    }
    res.writeHead(200, { 'Content-Type': types[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
    fs.createReadStream(file).pipe(res);
  })
  .listen(port, () => console.log(`serving on http://localhost:${port}  (harness: /harness)`));
