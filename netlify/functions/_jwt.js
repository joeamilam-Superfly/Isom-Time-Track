// Minimal signed-token helper. Not a full JWT library, but uses the same
// header.payload.signature structure with HMAC-SHA256 so it's inspectable
// and standard-shaped. Good enough for a small internal crew app; avoids
// pulling in a JWT dependency for a single signing/verifying need.
const crypto = require('crypto');

function base64url(input) {
  return Buffer.from(input)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

function base64urlDecode(str) {
  str = str.replace(/-/g, '+').replace(/_/g, '/');
  while (str.length % 4) str += '=';
  return Buffer.from(str, 'base64').toString('utf8');
}

function getSecret() {
  const secret = process.env.AUTH_TOKEN_SECRET;
  if (!secret) {
    throw new Error('AUTH_TOKEN_SECRET environment variable is not set');
  }
  return secret;
}

function sign(payload, expiresInSeconds = 60 * 60 * 24 * 14) {
  const header = { alg: 'HS256', typ: 'JWT' };
  const fullPayload = {
    ...payload,
    iat: Math.floor(Date.now() / 1000),
    exp: Math.floor(Date.now() / 1000) + expiresInSeconds,
  };
  const headerEncoded = base64url(JSON.stringify(header));
  const payloadEncoded = base64url(JSON.stringify(fullPayload));
  const signature = crypto
    .createHmac('sha256', getSecret())
    .update(`${headerEncoded}.${payloadEncoded}`)
    .digest('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
  return `${headerEncoded}.${payloadEncoded}.${signature}`;
}

function verify(token) {
  if (!token || typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [headerEncoded, payloadEncoded, signature] = parts;
  const expectedSignature = crypto
    .createHmac('sha256', getSecret())
    .update(`${headerEncoded}.${payloadEncoded}`)
    .digest('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');

  const sigBuf = Buffer.from(signature);
  const expBuf = Buffer.from(expectedSignature);
  if (sigBuf.length !== expBuf.length || !crypto.timingSafeEqual(sigBuf, expBuf)) {
    return null;
  }

  let payload;
  try {
    payload = JSON.parse(base64urlDecode(payloadEncoded));
  } catch {
    return null;
  }

  if (payload.exp && Math.floor(Date.now() / 1000) > payload.exp) {
    return null; // expired
  }

  return payload;
}

module.exports = { sign, verify };
