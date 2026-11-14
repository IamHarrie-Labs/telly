// Buffer only redirects to HTTPS URIs, even on localhost, so local development needs a certificate.
// This writes a self-signed one to certs/. Your browser will ask you to accept it once.
import fs from 'node:fs';
import path from 'node:path';
import selfsigned from 'selfsigned';
import { root } from '../lib/config.js';

const dir = path.join(root, 'certs');
fs.mkdirSync(dir, { recursive: true });

const pems = await selfsigned.generate([{ name: 'commonName', value: 'localhost' }], {
  keySize: 2048,
  algorithm: 'sha256',
  notAfterDate: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000),
  extensions: [
    { name: 'basicConstraints', cA: false },
    {
      name: 'subjectAltName',
      altNames: [
        { type: 2, value: 'localhost' },
        { type: 7, ip: '127.0.0.1' },
      ],
    },
  ],
});

fs.writeFileSync(path.join(dir, 'localhost-key.pem'), pems.private, { mode: 0o600 });
fs.writeFileSync(path.join(dir, 'localhost-cert.pem'), pems.cert);
console.log('Wrote certs/localhost-key.pem and certs/localhost-cert.pem');
