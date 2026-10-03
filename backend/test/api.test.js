import {test, before, after, beforeEach} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {MongoMemoryServer} from 'mongodb-memory-server';
import {MongoClient} from 'mongodb';
import request from 'supertest';
import {createApp} from '../src/app.js';
import {initializeDatabase} from '../src/db.js';
import {hashPin, verifyPin, newPin} from '../src/auth.js';

let mongo, client, db, app, adminHash, adminPin;
before(async () => {
  mongo = await MongoMemoryServer.create({instance: {args: ['--nounixsocket']}});
  client = new MongoClient(mongo.getUri());
  await client.connect();
  adminPin = newPin();
  adminHash = await hashPin(adminPin);
});
after(async () => { await client?.close(); await mongo?.stop(); });
beforeEach(async () => {
  db = client.db('test_' + randomUUID().replaceAll('-', ''));
  await initializeDatabase(db);
  app = createApp(db, {adminPinHash: adminHash});
});
const post = (agent, path, body) => agent.post(path).set('Origin', 'http://localhost:3000').send(body);
async function customer(phone = '9876543210') {
  const agent = request.agent(app);
  const r = await post(agent, '/api/auth', {action: 'register', phone}).expect(201);
  return {agent, phone, pin: r.body.pin, id: r.body.user.subject};
}
async function admin() {
  const agent = request.agent(app);
  await post(agent, '/api/auth', {action: 'admin_login', pin: adminPin}).expect(200);
  return agent;
}
const order = (phone, extra = {}) => ({requestId: randomUUID(), name: 'Flower Customer', phone, address: '123 Flower Road Bengaluru', area: 'Vijayanagar', date: new Date(Date.now() + 86400000).toISOString().slice(0, 10), notes: '', language: 'en', consent: true, items: [{id: 'mallige', quantity: 2}], ...extra});

test('registration generates a permanent PIN once, stores hashes, and logs in again', async () => {
  const c = await customer();
  assert.match(c.pin, /^\d{4}$/);
  const record = await db.collection('customers').findOne({_id: c.id});
  assert.notEqual(record.pin_hash, c.pin);
  assert.equal(await verifyPin(c.pin, record.pin_hash), true);
  const cookie = (await post(c.agent, '/api/auth', {action: 'login', phone: c.phone, pin: c.pin})).headers['set-cookie'][0];
  assert.match(cookie, /HttpOnly/); assert.match(cookie, /SameSite=Strict/);
  assert.doesNotMatch(cookie, /Secure/); // Local HTTP remains usable.
  const session = await c.agent.get('/api/auth').expect(200);
  assert.equal(session.body.user.subject, c.id); assert.equal(session.body.pin, undefined);
  const login = await post(c.agent, '/api/auth', {action: 'login', phone: c.phone, pin: c.pin}).expect(200);
  assert.equal(login.body.pin, undefined);
  await post(c.agent, '/api/auth', {action: 'register', phone: c.phone}).expect(409);
  await post(c.agent, '/api/auth', {action: 'login', phone: c.phone, pin: c.pin === '0000' ? '0001' : '0000'}).expect(401);
  const sessions = await db.collection('sessions').find().toArray();
  assert.equal(sessions.every(s => /^[a-f0-9]{64}$/.test(s._id)), true);
});

test('production cookies are secure and admin PIN is configured server-side', async () => {
  const productionApp = createApp(db, {adminPinHash: adminHash, production: true, frontendUrl: 'https://flowers.example'});
  const r = await request(productionApp).post('/api/auth').set('Origin', 'https://flowers.example').send({action: 'admin_login', pin: adminPin}).expect(200);
  assert.match(r.headers['set-cookie'][0], /Secure/);
  assert.equal(r.body.user.role, 'admin');
  await post(request(app), '/api/auth', {action: 'admin_login', pin: '0000'}).expect(401);
  const missing = createApp(db, {});
  await post(request(missing), '/api/auth', {action: 'admin_login', pin: adminPin}).expect(503);
});

test('role guards protect admin and customer routes', async () => {
  await request(app).get('/api/admin').expect(401);
  await request(app).get('/api/account').expect(401);
  await post(request(app), '/api/orders', order('9876543210')).expect(401);
  const c = await customer(); await c.agent.get('/api/admin').expect(403);
  const a = await admin(); await a.get('/api/account').expect(403);
});

test('orders snapshot products, enforce ownership, and retry idempotently', async () => {
  const c = await customer(), other = await customer('9876543211'), b = order(c.phone);
  const first = await post(c.agent, '/api/orders', b).expect(201);
  const second = await post(c.agent, '/api/orders', b).expect(200);
  assert.equal(first.body.reference, second.body.reference);
  assert.equal(await db.collection('orders').countDocuments(), 1);
  await post(other.agent, '/api/orders', {...b, phone: other.phone}).expect(409);
  const own = await c.agent.get('/api/account').expect(200);
  assert.equal(own.body.orders[0].items[0].name, 'Mallige');
  assert.equal(own.body.orders[0].quoted_amount, null);
  const empty = await other.agent.get('/api/account').expect(200);
  assert.equal(empty.body.orders.length, 0);
  await db.collection('orders').insertOne({_id: randomUUID(), customer_id: null, phone: other.phone, created_at: new Date().toISOString()});
  assert.equal((await other.agent.get('/api/account')).body.orders.length, 0);
});

test('concurrent retries never create duplicate orders', async () => {
  const c = await customer(), b = order(c.phone);
  const replies = await Promise.all(Array.from({length: 5}, () => post(c.agent, '/api/orders', b)));
  assert.equal(replies.every(r => [200, 201].includes(r.status)), true);
  assert.equal(await db.collection('orders').countDocuments(), 1);
});

test('delivery validation rejects unavailable flowers and malformed dates', async () => {
  const c = await customer();
  for (const extra of [{date: '2026-02-31'}, {date: '2000-01-01'}, {area: 'Unknown'}, {consent: false}, {items: [{id: 'mallige', quantity: 0}]}, {items: [{id: 'mallige', quantity: 1}, {id: 'mallige', quantity: 2}]}]) {
    await post(c.agent, '/api/orders', order(c.phone, extra)).expect(400);
  }
  await post(c.agent, '/api/orders', order('9876543211')).expect(400);
  await db.collection('catalog').updateOne({_id: 'mallige'}, {$set: {available: false}});
  await post(c.agent, '/api/orders', order(c.phone)).expect(409);
});

test('admin quotes and customer acceptance update the actual MongoDB order', async () => {
  const c = await customer(), other = await customer('9876543211'), a = await admin(), b = order(c.phone);
  await post(c.agent, '/api/orders', b).expect(201);
  await post(a, '/api/admin', {action: 'update_order', order: {id: b.requestId, status: 'quoted', quoted_amount: null}}).expect(400);
  await post(a, '/api/admin', {action: 'update_order', order: {id: b.requestId, status: 'quoted', quoted_amount: 25000}}).expect(200);
  await post(other.agent, '/api/account', {action: 'accept_quote', id: b.requestId}).expect(409);
  await post(c.agent, '/api/account', {action: 'accept_quote', id: b.requestId}).expect(200);
  assert.equal((await db.collection('orders').findOne({_id: b.requestId})).status, 'confirmed');
  await post(c.agent, '/api/account', {action: 'accept_quote', id: b.requestId}).expect(409);
  const result = await a.get('/api/admin').expect(200);
  assert.equal(result.body.customers.find(v => v.id === c.id).order_count, 1);
  assert.doesNotMatch(JSON.stringify(result.body), /pin_hash|auth_version/);
});

test('catalog edits and soft removal survive database initialization', async () => {
  const a = await admin();
  const p = {name: 'Custom haar', kn: '', description: 'Special flowers', description_kn: '', unit: 'piece', unit_kn: '', category: 'garlands', image: '/generated-hero.webp', available: true, guide_price: 20000};
  const r = await post(a, '/api/admin', {action: 'save_product', product: p}).expect(200);
  await post(a, '/api/admin', {action: 'save_product', product: {...p, id: r.body.id, available: false}}).expect(200);
  const publicData = await request(app).get('/api/products').expect(200);
  assert.equal(publicData.body.products.find(v => v.id === r.body.id).available, false);
  assert.doesNotMatch(JSON.stringify(publicData.body), /guide_price/);
  await post(a, '/api/admin', {action: 'remove_product', id: 'mallige'}).expect(200);
  await initializeDatabase(db);
  assert.equal((await request(app).get('/api/products')).body.products.some(v => v.id === 'mallige'), false);
  await post(a, '/api/admin', {action: 'save_product', product: {...p, image: 'https://untrusted.example/image.png'}}).expect(400);
});

test('PIN reset replaces the old PIN and invalidates even racing old sessions', async () => {
  const c = await customer(), a = await admin();
  const r = await post(a, '/api/admin', {action: 'reset_pin', id: c.id}).expect(200);
  assert.notEqual(r.body.pin, c.pin);
  await c.agent.get('/api/account').expect(401);
  await post(c.agent, '/api/auth', {action: 'login', phone: c.phone, pin: c.pin}).expect(401);
  await post(c.agent, '/api/auth', {action: 'login', phone: c.phone, pin: r.body.pin}).expect(200);
  await c.agent.get('/api/account').expect(200);
  assert.equal((await db.collection('customers').findOne({_id: c.id})).auth_version, 1);
  // A session inserted after reset with the pre-reset version cannot authenticate.
  const {authService} = await import('../src/auth.js');
  let value;
  await authService(db, false).createSession({cookie: (k, token) => { value = token; }}, c.id, 'customer', 0);
  const stale = await request(app).get('/api/auth').set('Cookie', `nc_session=${value}`).expect(200);
  assert.equal(stale.body.user, null);
});

test('logout revokes the cookie token and sessions expire', async () => {
  const c = await customer();
  await post(c.agent, '/api/auth', {action: 'logout'}).expect(200);
  await c.agent.get('/api/account').expect(401);
  await post(c.agent, '/api/auth', {action: 'login', phone: c.phone, pin: c.pin}).expect(200);
  await db.collection('sessions').updateMany({}, {$set: {expires_at: new Date(0)}});
  await c.agent.get('/api/account').expect(401);
});

test('origin, content type, body limits, and login rate limits reject invalid requests', async () => {
  await request(app).post('/api/auth').set('Origin', 'https://evil.example').send({action: 'register', phone: '9876543210'}).expect(403);
  await request(app).post('/api/auth').set('Sec-Fetch-Site', 'cross-site').send({action: 'logout'}).expect(403);
  await request(app).post('/api/auth').send('text').expect(415);
  await request(app).post('/api/auth').set('Content-Type', 'application/json').send('{oops').expect(400);
  await post(request(app), '/api/auth', {action: 'register', phone: '9876543210', x: 'x'.repeat(13000)}).expect(413);
  for (let i = 0; i < 8; i++) await post(request(app), '/api/auth', {action: 'admin_login', pin: '0000'}).expect(401);
  await post(request(app), '/api/auth', {action: 'admin_login', pin: adminPin}).expect(429);
});
