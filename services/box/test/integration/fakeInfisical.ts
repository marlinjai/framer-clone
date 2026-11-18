// services/box/test/integration/fakeInfisical.ts
//
// A stand-in for Infisical, for the image test: the two calls the real
// Infisical client makes when the box starts (a universal auth login, then
// the secrets of one project), answered from a configuration the test makes
// at run time. It runs in a container of the box image itself (node is the
// one program there to run it), on the test's private docker network, under
// a name without a dot, so the box reaches it over plain http. Nothing here
// reaches Infisical.
//
// The configuration comes in the environment variable FAKE_INFISICAL_CONFIG:
// the client id and secret it accepts, the token it hands out, and the
// secrets of each project id; the project id `box-hang` is never answered. It records the method and path of every
// request (never a body or a header) and answers `GET /__requests` with them.

export interface FakeInfisicalConfig {
  clientId: string;
  clientSecret: string;
  token: string;
  projects: Record<string, Record<string, string>>;
}

export const FAKE_INFISICAL_PORT = 8081;

export const FAKE_INFISICAL_SCRIPT = `
const http = require('http');
const cfg = JSON.parse(process.env.FAKE_INFISICAL_CONFIG);
const seen = [];
function send(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}
http.createServer((req, res) => {
  const url = new URL(req.url, 'http://fake');
  if (url.pathname === '/__requests') return send(res, 200, seen);
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    const authorized = req.headers.authorization === 'Bearer ' + cfg.token;
    seen.push({ method: req.method, path: url.pathname, authorized, projectId: url.searchParams.get('projectId'), environment: url.searchParams.get('environment'), secretPath: url.searchParams.get('secretPath') });
    if (req.method === 'POST' && /^\\/api\\/v1\\/auth\\/universal-auth\\/login\\/?$/.test(url.pathname)) {
      let body = {};
      try { body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); } catch {}
      if (body.clientId !== cfg.clientId || body.clientSecret !== cfg.clientSecret) return send(res, 401, { statusCode: 401, message: 'Invalid credentials', error: 'UnauthorizedError' });
      return send(res, 200, { accessToken: cfg.token, expiresIn: 7200, accessTokenMaxTTL: 7200, tokenType: 'Bearer' });
    }
    if (req.method === 'GET' && url.pathname === '/api/v4/secrets') {
      if (!authorized) return send(res, 401, { statusCode: 401, message: 'Invalid token', error: 'UnauthorizedError' });
      // A fetch Infisical accepts and never answers, for the start program's time limit.
      if (url.searchParams.get('projectId') === 'box-hang') return;
      const project = cfg.projects[url.searchParams.get('projectId')];
      if (!project || url.searchParams.get('environment') !== 'prod') return send(res, 404, { statusCode: 404, message: 'Not found', error: 'NotFound' });
      const secrets = Object.entries(project).map(([key, value], i) => ({
        _id: 'fake-' + i, id: 'fake-' + i, version: 1, workspace: url.searchParams.get('projectId'), type: 'shared', environment: 'prod',
        secretKey: key, secretValue: value, secretComment: '', secretPath: '/', skipMultilineEncoding: false, tags: [], secretValueHidden: false,
      }));
      return send(res, 200, { secrets, imports: [] });
    }
    send(res, 404, { statusCode: 404, message: 'Not found', error: 'NotFound' });
  });
}).listen(${FAKE_INFISICAL_PORT}, '0.0.0.0');
`;
