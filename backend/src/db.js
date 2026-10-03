import {products} from './catalog.js';
export async function initializeDatabase(db) {
  await Promise.all([
    db.collection('customers').createIndex({phone: 1}, {unique: true}),
    db.collection('sessions').createIndex({expires_at: 1}, {expireAfterSeconds: 0}),
    db.collection('auth_limits').createIndex({expires_at: 1}, {expireAfterSeconds: 0}),
    db.collection('orders').createIndex({customer_id: 1, created_at: -1}),
    db.collection('orders').createIndex({created_at: -1}),
  ]);
  await db.collection('catalog').bulkWrite(products.map(p => ({updateOne: {
    filter: {_id: p.id}, update: {$setOnInsert: {
      name: p.name, kn: p.kn, description: p.desc, description_kn: p.descKn,
      unit: p.unit, unit_kn: p.unitKn, category: p.category, image: p.image,
      color: p.color, available: true, active: true, guide_price: null, updated_at: new Date().toISOString(),
    }}, upsert: true,
  }})));
}
export const view = ({_id, ...fields}) => ({id: _id, ...fields});
export const publicProduct = p => ({id: p._id, name: p.name, kn: p.kn || p.name, desc: p.description,
  descKn: p.description_kn || p.description, unit: p.unit, unitKn: p.unit_kn || p.unit,
  category: p.category, image: p.image, color: p.color, available: !!p.available, sub: p.name, subKn: p.kn || p.name});
