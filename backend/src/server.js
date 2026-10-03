import 'dotenv/config';
import {MongoClient} from 'mongodb';
import {initializeDatabase} from './db.js';
import {createApp} from './app.js';

const production = process.env.NODE_ENV === 'production';
const uri = process.env.MONGODB_URI;
if (!uri) throw new Error('Set MONGODB_URI in backend/.env; run npm run setup first.');
const adminPinHash = process.env.ADMIN_PIN_HASH;
if (!/^[a-f0-9]{32}\.[a-f0-9]{64}$/.test(adminPinHash || '')) throw new Error('Configure ADMIN_PIN_HASH with npm run setup.');
const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:3000';
if (production && new URL(frontendUrl).protocol !== 'https:') throw new Error('Production FRONTEND_URL must use HTTPS.');
const trustProxyHops = Number(process.env.TRUST_PROXY_HOPS || 0);
if (!Number.isInteger(trustProxyHops) || trustProxyHops < 0) throw new Error('Invalid TRUST_PROXY_HOPS.');
const client = new MongoClient(uri, {serverSelectionTimeoutMS: 10000});
await client.connect();
const db = client.db();
await initializeDatabase(db);
const app = createApp(db, {adminPinHash, frontendUrl, production, trustProxyHops});
const server = app.listen(Number(process.env.PORT || 4000), '0.0.0.0', () => console.log('NC Daily Blooms API is ready.'));
async function stop() { server.close(async () => { await client.close(); process.exit(0); }); }
process.once('SIGINT', stop);
process.once('SIGTERM', stop);
