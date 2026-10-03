import {randomBytes, randomInt, pbkdf2, timingSafeEqual, createHash} from 'node:crypto';
import {promisify} from 'node:util';
const derive = promisify(pbkdf2);
export const hash = value => createHash('sha256').update(value).digest('hex');
export const newPin = () => String(randomInt(1000, 10000));
export async function hashPin(pin, salt = randomBytes(16).toString('hex')) {
  const result = await derive(pin, salt, 100000, 32, 'sha256');
  return `${salt}.${result.toString('hex')}`;
}
export async function verifyPin(pin, stored) {
  if (!/^[a-f0-9]{32}\.[a-f0-9]{64}$/.test(stored || '')) return false;
  const actual = Buffer.from(await hashPin(pin, stored.split('.')[0]));
  return timingSafeEqual(actual, Buffer.from(stored));
}
export class ApiError extends Error {
  constructor(status, code) { super(code); this.status = status; this.code = code; }
}
export function authService(db, production) {
  const customers = db.collection('customers'), sessions = db.collection('sessions');
  const token = req => req.headers.cookie?.split(';').map(s => s.trim()).find(s => s.startsWith('nc_session='))?.slice(11);
  const cookie = (res, value, maxAge) => res.cookie('nc_session', value, {httpOnly: true, secure: production, sameSite: 'strict', path: '/', maxAge});
  async function getSession(req) {
    const value = token(req);
    if (!/^[a-f0-9]{64}$/.test(value || '')) return null;
    const row = await sessions.findOne({_id: hash(value), expires_at: {$gt: new Date()}});
    if (!row) return null;
    if (row.role === 'admin') return {subject: 'single_admin', role: 'admin'};
    const c = await customers.findOne({_id: row.subject, auth_version: row.auth_version});
    return c ? {subject: c._id, role: 'customer', phone: c.phone, name: c.name} : null;
  }
  async function requireSession(req, role) {
    const user = await getSession(req);
    if (!user) throw new ApiError(401, 'sign_in_required');
    if (user.role !== role) throw new ApiError(403, 'access_denied');
    return user;
  }
  async function createSession(res, subject, role, authVersion = 0) {
    const value = randomBytes(32).toString('hex');
    const maxAge = (role === 'admin' ? 28800 : 2592000) * 1000;
    await sessions.insertOne({_id: hash(value), subject, role, auth_version: authVersion, expires_at: new Date(Date.now() + maxAge)});
    cookie(res, value, maxAge);
  }
  async function logout(req, res) {
    const value = token(req);
    if (value) await sessions.deleteOne({_id: hash(value)});
    cookie(res, '', 0);
  }
  async function limit(req, scope) {
    const bucket = Math.floor(Date.now() / 900000);
    for (const [name, max] of [[scope, 8], [`ip:${req.ip}`, 40]]) {
      const _id = hash(`${name}:${bucket}`);
      const row = await db.collection('auth_limits').findOneAndUpdate({_id}, {$inc: {attempts: 1}, $setOnInsert: {expires_at: new Date((bucket + 1) * 900000)}}, {upsert: true, returnDocument: 'after'});
      if (row.attempts > max) throw new ApiError(429, 'too_many_attempts');
    }
  }
  return {getSession, requireSession, createSession, logout, limit};
}
