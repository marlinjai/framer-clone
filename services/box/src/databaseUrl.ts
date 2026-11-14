// services/box/src/databaseUrl.ts
//
// The one reading of the database address. The box reads it here and hands
// the driver the parts, never the text, so the two can never read it
// differently: the host the box checked is the host that is connected to, and
// no parameter in the address can change a limit.

export interface DatabaseTarget {
  host: string;
  port: number;
  database: string;
  username: string;
  password: string;
}

/** Why an address was refused. The message never holds a part of the address. */
export class DatabaseUrlError extends Error {}

// A name as a private network gives it (a container or service name may hold an underscore) or an IPv4 address.
const HOST_PATTERN = /^(?:[a-z0-9](?:[a-z0-9_-]{0,61}[a-z0-9])?)(?:\.[a-z0-9](?:[a-z0-9_-]{0,61}[a-z0-9])?)*$/;

/** True when a text holds a character that would end a value in the database's startup packet, or any other control character. */
function hasControlCharacter(text: string): boolean {
  for (let i = 0; i < text.length; i++) {
    const unit = text.charCodeAt(i);
    if (unit < 0x20 || unit === 0x7f) return true;
  }
  return false;
}

function decoded(text: string): string {
  try {
    return decodeURIComponent(text);
  } catch {
    throw new DatabaseUrlError('holds a malformed percent escape');
  }
}

export function parseDatabaseUrl(value: string): DatabaseTarget {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new DatabaseUrlError('is not a connection string');
  }
  if (url.protocol !== 'postgres:' && url.protocol !== 'postgresql:') throw new DatabaseUrlError('is not a Postgres connection string');
  // One host, by name or IPv4 address: no list, no escape, no bracketed address. Read without regard to
  // case and to a closing dot, as names are.
  const host = url.hostname.toLowerCase().replace(/\.$/, '');
  if (!HOST_PATTERN.test(host) || host.length > 253) throw new DatabaseUrlError('must name one host, by name or IPv4 address');
  const port = url.port === '' ? 5432 : Number(url.port);
  const username = decoded(url.username);
  const password = decoded(url.password);
  const database = decoded(url.pathname.replace(/^\//, ''));
  if (username === '') throw new DatabaseUrlError('must name a role');
  if (database === '' || database.includes('/')) throw new DatabaseUrlError('must name one database');
  // The role and the database travel in the startup packet, where a zero byte ends a value and starts
  // the next parameter: such a character would add a parameter the address is not allowed to carry.
  if (hasControlCharacter(username) || hasControlCharacter(database) || hasControlCharacter(password)) {
    throw new DatabaseUrlError('holds a control character');
  }
  if (url.hash !== '') throw new DatabaseUrlError('must not hold a fragment');
  // The only parameter allowed is `sslmode=disable`, once, which says what this version does anyway:
  // it speaks to the database without Transport Layer Security, over the private network the two
  // share (decision D23). An address that asks for encryption is refused, not half honoured: the box
  // opens its own sockets, and checking a certificate against the right name on them is not built.
  const keys = [...url.searchParams.keys()];
  if (keys.some((key) => key !== 'sslmode')) throw new DatabaseUrlError('may hold no parameter but sslmode');
  if (keys.length > 1) throw new DatabaseUrlError('holds sslmode more than once');
  if (keys.length === 1 && url.searchParams.get('sslmode') !== 'disable') {
    throw new DatabaseUrlError('asks for an sslmode this version does not support: only disable');
  }
  return { host, port, database, username, password };
}
