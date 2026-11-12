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
  /** False: no Transport Layer Security (a private network). `require` encrypts without checking the certificate; only `verify-full` checks it. */
  ssl: false | 'require' | 'verify-full';
}

/** Why an address was refused. The message never holds a part of the address. */
export class DatabaseUrlError extends Error {}

const HOST_PATTERN = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/;

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
  // One host, by name or IPv4 address: no list, no escape, no bracketed address.
  if (!HOST_PATTERN.test(url.hostname) || url.hostname.length > 253) throw new DatabaseUrlError('must name one host, by name or IPv4 address');
  const port = url.port === '' ? 5432 : Number(url.port);
  const username = decoded(url.username);
  const password = decoded(url.password);
  const database = decoded(url.pathname.replace(/^\//, ''));
  if (username === '') throw new DatabaseUrlError('must name a role');
  if (database === '' || database.includes('/')) throw new DatabaseUrlError('must name one database');
  if (url.hash !== '') throw new DatabaseUrlError('must not hold a fragment');
  // The only parameter is `sslmode`, once. Anything else could change a limit the box relies on.
  let ssl: DatabaseTarget['ssl'] = false;
  const keys = [...url.searchParams.keys()];
  if (keys.some((key) => key !== 'sslmode')) throw new DatabaseUrlError('may hold no parameter but sslmode');
  if (keys.length > 1) throw new DatabaseUrlError('holds sslmode more than once');
  if (keys.length === 1) {
    const mode = url.searchParams.get('sslmode');
    if (mode === 'require' || mode === 'verify-full') ssl = mode;
    else if (mode !== 'disable') throw new DatabaseUrlError('holds an sslmode that is not disable, require or verify-full');
  }
  return { host: url.hostname, port, database, username, password, ssl };
}
