// Accounts: password hashing, handle rules, session tokens. scrypt ships with Node,
// so there is no bcrypt dependency and no plaintext password is ever stored.
import { createHash, randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const derive = promisify(scrypt);
const KEY_LEN = 64;
const SCRYPT_PARAMS = { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };

export const HANDLE_PATTERN = /^[a-z0-9][a-z0-9_.-]{1,29}$/;
export const SESSION_COOKIE = 'openmic_session';
export const SESSION_TTL_MS = 1000 * 60 * 60 * 24 * 30;

export async function hashPassword(password, salt = randomBytes(16).toString('hex')) {
  const key = await derive(String(password), salt, KEY_LEN, SCRYPT_PARAMS);
  return { salt, hash: key.toString('hex') };
}

export async function verifyPassword(password, salt, expected) {
  if (typeof salt !== 'string' || typeof expected !== 'string') return false;
  const key = await derive(String(password), salt, KEY_LEN, SCRYPT_PARAMS);
  const stored = Buffer.from(expected, 'hex');
  return stored.length === key.length && timingSafeEqual(key, stored);
}

export function newId(prefix) {
  return prefix + '-' + randomBytes(9).toString('base64url');
}

export function newToken() {
  return randomBytes(32).toString('base64url');
}

// Sessions are looked up by digest, so a leaked db.json cannot be replayed as a cookie.
export function digestToken(token) {
  return createHash('sha256').update(String(token)).digest('hex');
}

export function emailProblem(value) {
  const email = String(value || '').trim().toLowerCase();
  if (!email) return 'Email is required.';
  if (email.length > 254) return 'That email address is too long.';
  if (!/^[^\s@(),:;<>[\]"]+@[^\s@,]+\.[A-Za-z]{2,}$/.test(email)) return 'That does not look like an email address.';
  return null;
}

// A weak password on a site that hosts other people's uploads is not a small problem:
// it is the account that gets used to publish infringing audio under someone's handle.
export function passwordProblem(value) {
  const password = String(value || '');
  if (!password) return 'Password is required.';
  if (password.length < 10) return 'Use at least 10 characters.';
  if (password.length > 200) return 'That password is too long.';
  if (/^(.)\1+$/.test(password)) return 'That password is too repetitive.';
  if (/^(password|letmein|iloveyou|qwerty|abc123|1234567890)/i.test(password)) return 'That password is too common.';
  return null;
}

export function handleProblem(value) {
  const handle = normalizeHandle(value);
  if (!handle) return 'Pick an artist handle.';
  if (!HANDLE_PATTERN.test(handle)) return 'Handles are 3-30 characters: letters, numbers, dot, underscore, dash.';
  if (/^_|_$|[._-]$|\.\./.test(handle)) return 'That handle has dots, dashes or underscores in the wrong place.';
  if (RESERVED.has(handle)) return 'That handle is reserved. Pick another.';
  return null;
}

const RESERVED = new Set(['admin', 'root', 'api', 'openmic', 'support', 'team', 'help', 'about',
  'spotify', 'audius', 'notice', 'takedown', 'login', 'signup', 'stream', 'upload']);

export function normalizeHandle(value) {
  return String(value || '').trim().toLowerCase().slice(0, 40);
}

export function clipText(value, max) {
  return String(value || '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, max);
}
