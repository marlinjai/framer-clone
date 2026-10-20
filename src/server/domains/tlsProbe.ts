// src/server/domains/tlsProbe.ts
//
// The honest "active" check for a verified custom domain: open a TLS
// connection to the PLATFORM's own IPv4 address with the domain as the server
// name (SNI) and require a certificate that is trusted and valid for that
// exact name. It succeeds only once Traefik routes the host and Let's Encrypt
// has issued its certificate.
//
// It connects to the configured platform address, never to whatever the
// domain currently resolves to, so a domain owner cannot point the probe at an
// internal address (no server-side request forgery). No HTTP request is sent:
// the handshake alone answers the question.

import { connect } from 'node:tls';

export type TlsProbeResult = { ok: true } | { ok: false; reason: string };

export type TlsProbe = (hostname: string, address: string) => Promise<TlsProbeResult>;

export const TLS_PROBE_TIMEOUT_MS = 8_000;

export const probeCertificate: TlsProbe = (hostname, address) =>
  new Promise((resolve) => {
    let settled = false;
    const finish = (result: TlsProbeResult) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(result);
    };
    const socket = connect({
      host: address,
      port: 443,
      servername: hostname,
      // The default: the chain must be trusted AND the certificate must name
      // `servername` (Node's checkServerIdentity runs against it).
      rejectUnauthorized: true,
      timeout: TLS_PROBE_TIMEOUT_MS,
    });
    socket.once('secureConnect', () => finish({ ok: true }));
    socket.once('timeout', () => finish({ ok: false, reason: 'the TLS handshake timed out' }));
    socket.once('error', (err: NodeJS.ErrnoException) =>
      finish({ ok: false, reason: err.code ?? err.message }),
    );
  });
