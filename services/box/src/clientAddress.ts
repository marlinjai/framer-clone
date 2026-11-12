// services/box/src/clientAddress.ts
//
// Whose request this is, for the rate limit and the log. The address of the
// socket is the truth. `X-Forwarded-For` is read only when the socket's peer
// is a configured proxy, and then from the right, past every configured
// proxy: the first address a trusted hop wrote that is not itself a proxy.
// Anything a client wrote further left is never looked at.

/** An address as bytes: 4 for IPv4, 16 for IPv6. */
export type AddressBytes = Uint8Array;

export interface Cidr {
  bytes: AddressBytes;
  bits: number;
}

function parseIpv4(text: string): AddressBytes | null {
  const parts = text.split('.');
  if (parts.length !== 4) return null;
  const bytes = new Uint8Array(4);
  for (let i = 0; i < 4; i++) {
    const part = parts[i]!;
    if (!/^(0|[1-9][0-9]{0,2})$/.test(part)) return null;
    const value = Number(part);
    if (value > 255) return null;
    bytes[i] = value;
  }
  return bytes;
}

function parseIpv6(text: string): AddressBytes | null {
  if (text.length > 45 || !/^[0-9a-fA-F:.]+$/.test(text)) return null;
  const halves = text.split('::');
  if (halves.length > 2) return null;
  const groupsOf = (half: string, isEnd: boolean): number[] | null => {
    if (half === '') return [];
    const out: number[] = [];
    const parts = half.split(':');
    for (let i = 0; i < parts.length; i++) {
      const part = parts[i]!;
      if (part.includes('.')) {
        // A dotted IPv4 tail, only as the very last part of the whole address.
        if (!isEnd || i !== parts.length - 1) return null;
        const v4 = parseIpv4(part);
        if (!v4) return null;
        out.push((v4[0]! << 8) | v4[1]!, (v4[2]! << 8) | v4[3]!);
      } else {
        if (!/^[0-9a-fA-F]{1,4}$/.test(part)) return null;
        out.push(parseInt(part, 16));
      }
    }
    return out;
  };
  const head = groupsOf(halves[0]!, halves.length === 1);
  const tail = halves.length === 2 ? groupsOf(halves[1]!, true) : [];
  if (!head || !tail) return null;
  let groups: number[];
  if (halves.length === 2) {
    const missing = 8 - head.length - tail.length;
    if (missing < 1) return null;
    groups = [...head, ...new Array<number>(missing).fill(0), ...tail];
  } else {
    groups = head;
  }
  if (groups.length !== 8) return null;
  const bytes = new Uint8Array(16);
  for (let i = 0; i < 8; i++) {
    bytes[i * 2] = groups[i]! >> 8;
    bytes[i * 2 + 1] = groups[i]! & 0xff;
  }
  return bytes;
}

/** An address as bytes, or null. An IPv4 address mapped into IPv6 (`::ffff:a.b.c.d`) comes back as IPv4. No zone, no port, no brackets. */
export function parseAddress(text: unknown): AddressBytes | null {
  if (typeof text !== 'string' || text.length === 0 || text.length > 45) return null;
  const v4 = parseIpv4(text);
  if (v4) return v4;
  const v6 = parseIpv6(text);
  if (!v6) return null;
  const mapped = v6.subarray(0, 10).every((b) => b === 0) && v6[10] === 0xff && v6[11] === 0xff;
  return mapped ? v6.slice(12) : v6;
}

/** `a.b.c.d/n` or `x::/n`, or a bare address. Null for anything else. */
export function parseCidr(text: string): Cidr | null {
  const slash = text.indexOf('/');
  const bytes = parseAddress(slash === -1 ? text : text.slice(0, slash));
  if (!bytes) return null;
  const max = bytes.length * 8;
  if (slash === -1) return { bytes, bits: max };
  const bitsText = text.slice(slash + 1);
  if (!/^(0|[1-9][0-9]{0,2})$/.test(bitsText)) return null;
  const bits = Number(bitsText);
  return bits <= max ? { bytes, bits } : null;
}

function within(address: AddressBytes, cidr: Cidr): boolean {
  if (address.length !== cidr.bytes.length) return false;
  const whole = cidr.bits >> 3;
  for (let i = 0; i < whole; i++) if (address[i] !== cidr.bytes[i]) return false;
  const rest = cidr.bits & 7;
  if (rest === 0) return true;
  const mask = (0xff << (8 - rest)) & 0xff;
  return (address[whole]! & mask) === (cidr.bytes[whole]! & mask);
}

function isTrusted(address: AddressBytes, proxies: readonly Cidr[]): boolean {
  return proxies.some((cidr) => within(address, cidr));
}

function hex(bytes: AddressBytes, count: number): string {
  let out = '';
  for (let i = 0; i < count; i++) out += bytes[i]!.toString(16).padStart(2, '0');
  return out;
}

export interface ClientAddress {
  /** What the rate limit counts by: a whole IPv4 address, or the /56 of an IPv6 address (what one subscriber is usually given). */
  key: string;
  /** What the log holds: the /24 of an IPv4 address or the /48 of an IPv6 address, never a whole address. */
  logPrefix: string;
}

const UNKNOWN: ClientAddress = { key: 'unknown', logPrefix: 'unknown' };

/** How much of the end of `X-Forwarded-For` is read: room for a handful of hops. */
const FORWARDED_TAIL_LENGTH = 256;

/** A hop as some proxies write it: `[v6]`, `[v6]:port` or `v4:port`. The address part only. */
function hopAddress(hop: string): string {
  const bracketed = /^\[([0-9a-fA-F:.]+)\](?::[0-9]{1,5})?$/.exec(hop);
  if (bracketed) return bracketed[1]!;
  const withPort = /^([0-9.]+):[0-9]{1,5}$/.exec(hop);
  return withPort ? withPort[1]! : hop;
}

/** True when the peer of a socket is a configured proxy. */
export function isTrustedPeer(remoteAddress: unknown, proxies: readonly Cidr[]): boolean {
  const peer = parseAddress(remoteAddress);
  return peer !== null && isTrusted(peer, proxies);
}

function describe(bytes: AddressBytes): ClientAddress {
  if (bytes.length === 4) {
    return { key: `4:${bytes.join('.')}`, logPrefix: `${bytes[0]}.${bytes[1]}.${bytes[2]}.0/24` };
  }
  return { key: `6:${hex(bytes, 7)}`, logPrefix: `${hex(bytes, 6)}::/48` };
}

/**
 * The client of a request. All requests whose address cannot be read share
 * one bucket (`unknown`), so an unreadable address is limited, not exempt.
 */
export function clientAddressOf(remoteAddress: unknown, forwardedFor: unknown, proxies: readonly Cidr[]): ClientAddress {
  const peer = parseAddress(remoteAddress);
  if (!peer) return UNKNOWN;
  if (proxies.length === 0 || !isTrusted(peer, proxies) || typeof forwardedFor !== 'string') return describe(peer);
  // Only the end of the header is read, whatever its length: what a proxy appended is at the right,
  // and a client cannot push it out of view by sending a long header of its own.
  const sliced = forwardedFor.length > FORWARDED_TAIL_LENGTH;
  const hops = (sliced ? forwardedFor.slice(-FORWARDED_TAIL_LENGTH) : forwardedFor).split(',');
  // The first piece of a cut header is a fragment, not a hop.
  const first = sliced ? 1 : 0;
  for (let i = hops.length - 1; i >= first; i--) {
    const hop = parseAddress(hopAddress(hops[i]!.trim()));
    // A hop that is not an address ends the walk: nothing left of it was written by a proxy we know.
    if (!hop) return describe(peer);
    if (!isTrusted(hop, proxies)) return describe(hop);
  }
  return describe(peer);
}
