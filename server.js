#!/usr/bin/env node
// OpenClaw Mobile Dashboard - Static file server with TLS
const https = require('https');
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = parseInt(process.env.PORT || '8090', 10);
const BIND = process.env.BIND || '127.0.0.1';
const ROOT = __dirname;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json',
};

// Try to load TLS cert from OpenClaw's generated certs
function loadTLS() {
  const certDirs = [
    path.join(process.env.HOME || '/home/pc1', '.openclaw', 'gateway', 'tls'),
    path.join(process.env.HOME || '/home/pc1', '.openclaw', 'tls'),
  ];
  
  for (const dir of certDirs) {
    const certPath = path.join(dir, 'cert.pem');
    const keyPath = path.join(dir, 'key.pem');
    if (fs.existsSync(certPath) && fs.existsSync(keyPath)) {
      return {
        cert: fs.readFileSync(certPath),
        key: fs.readFileSync(keyPath),
      };
      }
  }
  
  // Generate self-signed cert
  console.log('No TLS certs found, generating self-signed...');
  const { execSync } = require('child_process');
  const tlsDir = path.join(ROOT, 'tls');
  if (!fs.existsSync(tlsDir)) fs.mkdirSync(tlsDir);
  const certPath = path.join(tlsDir, 'cert.pem');
  const keyPath = path.join(tlsDir, 'key.pem');
  
  if (!fs.existsSync(certPath)) {
    execSync(`openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 -nodes -keyout "${keyPath}" -out "${certPath}" -days 3650 -subj "/CN=openclaw-mobile"`, { stdio: 'pipe' });
  }
  
  return {
    cert: fs.readFileSync(certPath),
    key: fs.readFileSync(keyPath),
  };
}

function handler(req, res) {
  let urlPath = new URL(req.url, `https://${req.headers.host}`).pathname;
  
  // SPA fallback
  let filePath = path.join(ROOT, urlPath === '/' ? 'index.html' : urlPath);
  
  if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
    filePath = path.join(ROOT, 'index.html');
  }
  
  const ext = path.extname(filePath);
  const contentType = MIME[ext] || 'application/octet-stream';
  
  try {
    const data = fs.readFileSync(filePath);
    // Aggressive no-cache for HTML and JS to ensure updates reach users immediately
    const noCache = ['.html', '.js', '.json'].includes(ext);
    res.writeHead(200, {
      'Content-Type': contentType,
      'Cache-Control': noCache ? 'no-cache, no-store, must-revalidate' : 'public, max-age=3600',
      'Pragma': noCache ? 'no-cache' : '',
      'Expires': noCache ? '0' : '',
      'X-Content-Type-Options': 'nosniff',
    });
    res.end(data);
  } catch (e) {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not found');
  }
}

// Start server
try {
  const tls = loadTLS();
  const server = https.createServer(tls, handler);
  server.listen(PORT, BIND, () => {
    console.log(`OpenClaw Mobile Dashboard running at https://${BIND}:${PORT}`);
  });
} catch (e) {
  console.log('TLS failed, falling back to HTTP:', e.message);
  const server = http.createServer(handler);
  server.listen(PORT, BIND, () => {
    console.log(`OpenClaw Mobile Dashboard running at http://${BIND}:${PORT}`);
  });
}
