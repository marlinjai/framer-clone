// @vitest-environment node
//
// The signed MCP session id (src/server/mcp/session.ts): the facts a client
// declared at initialize come back from it, the client's name sanitised and
// capped (an open editor shows it as the agent's label when the key has no
// name), and an id of another key, a forged one or a tampered one reads as none.

import { describe, expect, it } from 'vitest';
import { issueSessionId, keyFingerprint, readSessionId, SESSION_CLIENT_NAME_MAX } from '../session';

const fingerprint = keyFingerprint('a-presented-key-built-for-this-test');

describe('the session id', () => {
  it('carries the protocol version, elicitation and the client name', () => {
    const id = issueSessionId({ protocolVersion: '2025-06-18', elicitation: true, clientName: 'Claude Code' }, fingerprint);
    expect(readSessionId(id, fingerprint)).toEqual({ protocolVersion: '2025-06-18', elicitation: true, clientName: 'Claude Code' });
  });

  it('sanitises the client name: control and direction characters go, one line, capped', () => {
    const id = issueSessionId({ protocolVersion: '2025-06-18', elicitation: false, clientName: '‮Evil\u0000\nName\t' + 'x'.repeat(200) }, fingerprint);
    const facts = readSessionId(id, fingerprint)!;
    expect(facts.clientName).toMatch(/^Evil Name x+…$/);
    expect(facts.clientName!.length).toBe(SESSION_CLIENT_NAME_MAX);
    expect(id.length).toBeLessThan(512);
  });

  it('removes every invisible or direction-changing character, and never splits a character at the cap', () => {
    for (const hidden of ['\u061c', '\u00ad', '\u{e0041}', '\u180e', '\ufff9', '\u2066', '\u200d']) {
      const id = issueSessionId({ protocolVersion: '2025-06-18', elicitation: false, clientName: `Cl${hidden}aude` }, fingerprint);
      expect(readSessionId(id, fingerprint)!.clientName).toBe('Cl aude');
    }
    const emoji = issueSessionId({ protocolVersion: '2025-06-18', elicitation: false, clientName: '\u{1f600}'.repeat(60) }, fingerprint);
    const name = readSessionId(emoji, fingerprint)!.clientName!;
    expect(Array.from(name).every((c) => c === '\u{1f600}' || c === '…')).toBe(true);
  });

  it('leaves out a name that is empty after sanitising', () => {
    const id = issueSessionId({ protocolVersion: '2025-06-18', elicitation: false, clientName: '\u0000​ ' }, fingerprint);
    expect(readSessionId(id, fingerprint)).toEqual({ protocolVersion: '2025-06-18', elicitation: false });
  });

  it('reads nothing from an id of another key or a tampered one', () => {
    const id = issueSessionId({ protocolVersion: '2025-06-18', elicitation: true, clientName: 'Claude' }, fingerprint);
    expect(readSessionId(id, keyFingerprint('another-key-built-for-this-test'))).toBeNull();
    const [payload, mac] = id.split('.');
    const forged = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(payload, 'base64url').toString()), c: 'Forged' })).toString('base64url');
    expect(readSessionId(`${forged}.${mac}`, fingerprint)).toBeNull();
  });
});
