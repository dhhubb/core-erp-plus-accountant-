/**
 * The branch server (decision 12: a branch runs a custom Next.js server, not Supabase).
 *
 * One Next.js build, two ways to serve it. The cloud runs `next start`. A branch runs this file,
 * which serves the same build over HTTPS on the shop LAN when a certificate is configured, and
 * over plain HTTP otherwise. HTTPS is what lets a till install the till as a PWA and use a secure
 * context; on a LAN there is no public certificate authority, so the branch uses one it is given.
 *
 * Environment:
 *   PORT           the port to listen on (default 3000)
 *   HOSTNAME       the interface to bind (default 0.0.0.0, so the LAN can reach it)
 *   TLS_CERT_FILE  path to the certificate; when set with TLS_KEY_FILE, HTTPS is used
 *   TLS_KEY_FILE   path to the private key
 *
 * Start it with:  BRANCH_MODE=branch TLS_CERT_FILE=certs/branch.crt TLS_KEY_FILE=certs/branch.key \
 *                 npm run start:branch
 */

import { createServer as createHttpsServer } from 'node:https';
import { createServer as createHttpServer } from 'node:http';
import { readFileSync } from 'node:fs';
import next from 'next';

const port = Number.parseInt(process.env.PORT ?? '3000', 10);
const hostname = process.env.HOSTNAME ?? '0.0.0.0';
const certFile = process.env.TLS_CERT_FILE;
const keyFile = process.env.TLS_KEY_FILE;

const app = next({ dev: false, hostname, port });
const handle = app.getRequestHandler();

await app.prepare();

const listener = (req, res) => handle(req, res);

let server;
if (certFile && keyFile) {
  server = createHttpsServer(
    { cert: readFileSync(certFile), key: readFileSync(keyFile) },
    listener,
  );
} else {
  // No certificate configured: serve HTTP. A desktop browser is fine with this; an installed PWA
  // needs HTTPS, so a real branch deployment sets the two TLS variables above.
  server = createHttpServer(listener);
}

server.listen(port, hostname, () => {
  const scheme = certFile && keyFile ? 'https' : 'http';
  console.log(`branch server ready on ${scheme}://${hostname}:${port}`);
});
