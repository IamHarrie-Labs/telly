import fs from 'node:fs';
import path from 'node:path';
import https from 'node:https';
import { config, root } from './lib/config.js';
import { app } from './lib/app.js';

if (config.isProd || process.env.TELLY_PLAIN_HTTP === '1') {
  // Production hosts terminate TLS for us. TELLY_PLAIN_HTTP is for local runs against the
  // fake Buffer only; the real Buffer needs an HTTPS redirect URI.
  app.listen(config.port, () => console.log(`Telly listening on :${config.port}`));
} else {
  // Buffer rejects http://localhost redirect URIs, so run local development over HTTPS.
  const keyFile = path.join(root, 'certs', 'localhost-key.pem');
  const certFile = path.join(root, 'certs', 'localhost-cert.pem');
  if (!fs.existsSync(keyFile) || !fs.existsSync(certFile)) {
    console.error('No local certificate found. Run: npm run certs');
    process.exit(1);
  }
  https
    .createServer({ key: fs.readFileSync(keyFile), cert: fs.readFileSync(certFile) }, app)
    .listen(config.port, () => {
      console.log(`Telly running at https://localhost:${config.port}`);
      console.log(`Redirect URI sent to Buffer: ${config.redirectUri}`);
      if (!config.clientId) console.log('BUFFER_CLIENT_ID is not set yet. Copy .env.example to .env.');
    });
}
