// Estación terrena COSTA — servidor del dashboard (solo Node.js >= 18, sin dependencias)
//
// Sirve los archivos de public/. La telemetría del BNO055 la entrega la API de Python
// (api/costa_api.py, puerto 8000), que lee el Nodo B por USB; el navegador se conecta directo a ella.

const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3000;
const PUBLIC_DIR = path.join(__dirname, 'public');
const TIPOS = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png' };

const server = http.createServer((req, res) => {
  const ruta = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  const archivo = path.normalize(path.join(PUBLIC_DIR, ruta === '/' ? 'index.html' : ruta));
  if (!archivo.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    return res.end('prohibido');
  }
  fs.readFile(archivo, (err, cont) => {
    if (err) {
      res.writeHead(404);
      return res.end('no encontrado');
    }
    res.writeHead(200, { 'Content-Type': (TIPOS[path.extname(archivo)] || 'application/octet-stream') + '; charset=utf-8' });
    res.end(cont);
  });
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`\n  El puerto ${PORT} ya está en uso (¿otro "npm start" abierto?).`);
    console.error(`  Ciérralo o usa otro puerto:  PORT=3001 npm start\n`);
    process.exit(1);
  }
  throw err;
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`\n  COSTA · Estación terrena`);
  console.log(`  Dashboard:   http://localhost:${PORT}`);
  console.log(`  Telemetría:  API de Python en :8000 (python api/costa_api.py)\n`);
});
