import express from 'express';
import {randomUUID} from 'node:crypto';
import {z} from 'zod';
import {authService, ApiError, hashPin, verifyPin, newPin} from './auth.js';
import {view, publicProduct} from './db.js';
import {areas, imageOptions, statuses} from './catalog.js';

const phoneSchema = z.string().regex(/^[6-9]\d{9}$/);
const pinSchema = z.string().regex(/^\d{4}$/);
function parse(schema, value, code = 'invalid_request') {
  const result = schema.safeParse(value);
  if (!result.success) throw new ApiError(400, code);
  return result.data;
}
const price = z.number().int().min(1).max(10000000).nullable();
const productSchema = z.object({
  id: z.string().min(1).max(80).optional(), name: z.string().trim().min(1).max(80), kn: z.string().trim().max(80),
  description: z.string().trim().max(250), description_kn: z.string().trim().max(250),
  unit: z.string().trim().min(1).max(25), unit_kn: z.string().trim().max(25), category: z.enum(['strings', 'loose', 'garlands']),
  image: z.enum(imageOptions).nullable(), available: z.boolean(), guide_price: z.number().int().min(0).max(10000000).nullable(),
});
const orderSchema = z.object({
  requestId: z.string().uuid(), name: z.string().trim().min(2).max(80), phone: phoneSchema,
  address: z.string().trim().min(8).max(300), area: z.enum(areas), date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  notes: z.string().trim().max(500), language: z.enum(['en', 'kn']), consent: z.literal(true),
  items: z.array(z.object({id: z.string().min(1).max(80), quantity: z.number().int().min(1).max(50)}).strict()).min(1).max(30),
}).strict();

export function createApp(db, {adminPinHash, frontendUrl = 'http://localhost:3000', production = false, trustProxyHops = 0}) {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', trustProxyHops);
  const allowedOrigin = new URL(frontendUrl).origin;
  const auth = authService(db, production);
  const customers = db.collection('customers'), catalog = db.collection('catalog'), orders = db.collection('orders');
  app.use('/api', (req, res, next) => {
    res.set('Cache-Control', 'no-store');
    res.set('X-Content-Type-Options', 'nosniff');
    if (!['GET', 'HEAD'].includes(req.method)) {
      const origin = req.get('origin');
      if ((origin && origin !== allowedOrigin) || req.get('sec-fetch-site') === 'cross-site') return next(new ApiError(403, 'invalid_origin'));
      if (!req.is('application/json')) return next(new ApiError(415, 'json_required'));
    }
    next();
  });
  app.use(express.json({limit: '12kb'}));
  app.get('/api/health', async (req, res) => {
    await db.command({ping: 1});
    res.json({ok: true});
  });
  app.get('/api/auth', async (req, res) => res.json({user: await auth.getSession(req)}));
  app.post('/api/auth', async (req, res) => {
    const b = req.body || {};
    if (b.action === 'logout') { await auth.logout(req, res); return res.json({ok: true}); }
    if (b.action === 'admin_login') {
      const pin = parse(pinSchema, b.pin, 'invalid_pin');
      await auth.limit(req, 'admin');
      if (!adminPinHash) throw new ApiError(503, 'admin_not_configured');
      if (!await verifyPin(pin, adminPinHash)) throw new ApiError(401, 'invalid_credentials');
      await auth.createSession(res, 'single_admin', 'admin');
      return res.json({user: {subject: 'single_admin', role: 'admin'}});
    }
    const phone = parse(phoneSchema, b.phone, 'invalid_phone');
    if (!['register', 'login'].includes(b.action)) throw new ApiError(400, 'invalid_request');
    await auth.limit(req, `customer:${phone}`);
    if (b.action === 'register') {
      if (await customers.findOne({phone})) throw new ApiError(409, 'account_exists');
      const pin = newPin(), _id = randomUUID();
      try {
        await customers.insertOne({_id, phone, name: '', pin_hash: await hashPin(pin), auth_version: 0, created_at: new Date().toISOString()});
      } catch (e) { if (e.code === 11000) throw new ApiError(409, 'account_exists'); throw e; }
      await auth.createSession(res, _id, 'customer', 0);
      return res.status(201).json({pin, user: {subject: _id, phone, name: '', role: 'customer'}});
    }
    const pin = parse(pinSchema, b.pin, 'invalid_pin');
    const c = await customers.findOne({phone});
    // Perform a derivation even for an unknown account to keep failure timing similar.
    const valid = await verifyPin(pin, c?.pin_hash || '0'.repeat(32) + '.' + '0'.repeat(64));
    if (!c || !valid) throw new ApiError(401, 'invalid_credentials');
    await auth.createSession(res, c._id, 'customer', c.auth_version);
    res.json({user: {subject: c._id, role: 'customer', phone, name: c.name}});
  });
  app.get('/api/products', async (req, res) => {
    const products = await catalog.find({active: true}).toArray();
    res.json({products: products.map(publicProduct)});
  });
  app.post('/api/orders', async (req, res) => {
    const s = await auth.requireSession(req, 'customer'), v = parse(orderSchema, req.body, 'invalid_order');
    if (v.phone !== s.phone) throw new ApiError(400, 'phone_mismatch');
    const today = new Intl.DateTimeFormat('en-CA', {timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit'}).format(new Date());
    const date = new Date(v.date + 'T00:00:00Z');
    if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== v.date || v.date < today || v.date > new Date(Date.now() + 366 * 86400000).toISOString().slice(0, 10) || new Set(v.items.map(i => i.id)).size !== v.items.length) throw new ApiError(400, 'invalid_order');
    const response = o => ({reference: o.reference, status: o.status, paymentTaken: false});
    const existing = await orders.findOne({_id: v.requestId});
    if (existing) {
      if (existing.customer_id !== s.subject) throw new ApiError(409, 'request_conflict');
      return res.json(response(existing));
    }
    const items = await Promise.all(v.items.map(async item => {
      const p = await catalog.findOne({_id: item.id, active: true, available: true});
      if (!p) throw new ApiError(409, 'product_unavailable');
      return {...item, name: p.name, kn: p.kn || p.name, unit: p.unit, unitKn: p.unit_kn || p.unit};
    }));
    const now = new Date().toISOString();
    const order = {_id: v.requestId, reference: 'NC-' + v.requestId.replaceAll('-', '').slice(0, 16).toUpperCase(), name: v.name, phone: s.phone,
      address: v.address, area: v.area, delivery_date: v.date, notes: v.notes, language: v.language, items,
      customer_id: s.subject, quoted_amount: null, status: 'price_requested', created_at: now, updated_at: now};
    try { await orders.insertOne(order); }
    catch (e) {
      if (e.code !== 11000) throw e;
      const raced = await orders.findOne({_id: v.requestId});
      if (raced.customer_id !== s.subject) throw new ApiError(409, 'request_conflict');
      return res.json(response(raced));
    }
    await customers.updateOne({_id: s.subject}, {$set: {name: v.name}});
    res.status(201).json(response(order));
  });
  app.get('/api/account', async (req, res) => {
    const user = await auth.requireSession(req, 'customer');
    const result = await orders.find({customer_id: user.subject}).sort({created_at: -1}).limit(100).toArray();
    res.json({user, orders: result.map(view)});
  });
  app.post('/api/account', async (req, res) => {
    const s = await auth.requireSession(req, 'customer'), b = req.body || {};
    if (b.action !== 'accept_quote' || typeof b.id !== 'string') throw new ApiError(400, 'invalid_request');
    const result = await orders.updateOne({_id: b.id, customer_id: s.subject, status: 'quoted', quoted_amount: {$gt: 0}}, {$set: {status: 'confirmed', updated_at: new Date().toISOString()}});
    if (!result.modifiedCount) throw new ApiError(409, 'quote_unavailable');
    res.json({ok: true});
  });
  app.get('/api/admin', async (req, res) => {
    await auth.requireSession(req, 'admin');
    const [o, p, c] = await Promise.all([
      orders.find().sort({created_at: -1}).limit(200).toArray(), catalog.find({active: true}).toArray(),
      customers.aggregate([{$sort: {created_at: -1}}, {$limit: 200}, {$lookup: {from: 'orders', let: {customer: '$_id'}, pipeline: [{$match: {$expr: {$eq: ['$customer_id', '$$customer']}}}, {$count: 'total'}], as: 'order_counts'}}, {$project: {phone: 1, name: 1, created_at: 1, order_count: {$ifNull: [{$arrayElemAt: ['$order_counts.total', 0]}, 0]}}}]).toArray(),
    ]);
    res.json({orders: o.map(view), products: p.map(view), customers: c.map(view)});
  });
  app.post('/api/admin', async (req, res) => {
    await auth.requireSession(req, 'admin');
    const b = req.body || {}, now = new Date().toISOString();
    if (b.action === 'update_order') {
      const v = parse(z.object({id: z.string(), status: z.enum(statuses), quoted_amount: price}), b.order);
      if (['quoted', 'confirmed', 'preparing', 'out_for_delivery', 'delivered'].includes(v.status) && !v.quoted_amount) throw new ApiError(400, 'quote_required');
      const r = await orders.updateOne({_id: v.id}, {$set: {status: v.status, quoted_amount: v.quoted_amount, updated_at: now}});
      if (!r.matchedCount) throw new ApiError(404, 'order_not_found');
      return res.json({ok: true});
    }
    if (b.action === 'save_product') {
      const {id, ...fields} = parse(productSchema, b.product, 'invalid_product');
      const _id = id || randomUUID();
      await catalog.updateOne({_id}, {$set: {...fields, updated_at: now}, $setOnInsert: {active: true, color: 'ivory'}}, {upsert: true});
      return res.json({id: _id});
    }
    if (b.action === 'remove_product' && typeof b.id === 'string') {
      const r = await catalog.updateOne({_id: b.id}, {$set: {active: false, updated_at: now}});
      if (!r.matchedCount) throw new ApiError(404, 'product_not_found');
      return res.json({ok: true});
    }
    if (b.action === 'reset_pin' && typeof b.id === 'string') {
      const c = await customers.findOne({_id: b.id});
      if (!c) throw new ApiError(404, 'customer_not_found');
      let pin = newPin();
      while (await verifyPin(pin, c.pin_hash)) pin = newPin();
      // Version changes invalidate sessions even if an old login races with this reset.
      const updated = await customers.findOneAndUpdate({_id: b.id, auth_version: c.auth_version}, {$set: {pin_hash: await hashPin(pin)}, $inc: {auth_version: 1}}, {returnDocument: 'after'});
      if (!updated) throw new ApiError(409, 'reset_conflict');
      await db.collection('sessions').deleteMany({subject: b.id, role: 'customer', auth_version: {$lt: updated.auth_version}});
      return res.json({pin, phone: c.phone});
    }
    throw new ApiError(400, 'invalid_request');
  });
  app.use('/api', (req, res) => res.status(404).json({error: 'not_found'}));
  app.use((error, req, res, next) => {
    if (error instanceof ApiError) return res.status(error.status).json({error: error.code});
    if (error.type === 'entity.too.large') return res.status(413).json({error: 'request_too_large'});
    if (error.type === 'entity.parse.failed') return res.status(400).json({error: 'invalid_request'});
    console.error('API request failed:', error.name || 'Error');
    res.status(503).json({error: 'service_unavailable'});
  });
  return app;
}
