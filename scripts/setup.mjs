import {createInterface} from 'node:readline/promises';
import {stdin, stdout} from 'node:process';
import {writeFile, access} from 'node:fs/promises';
import {hashPin} from '../backend/src/auth.js';

const question = createInterface({input: stdin, output: stdout});
try {
  try { await access('backend/.env'); console.log('backend/.env already exists. Edit it directly to change configuration.'); process.exitCode = 1; }
  catch {
    const uri = (await question.question('MongoDB URI [mongodb://127.0.0.1:27017/ncdailyblooms]: ')).trim() || 'mongodb://127.0.0.1:27017/ncdailyblooms';
    const pin = (await question.question('Single admin PIN (4 digits): ')).trim();
    if (!/^\d{4}$/.test(pin)) throw new Error('Admin PIN must have 4 digits.');
    if (/[\r\n]/.test(uri) || !/^mongodb(\+srv)?:\/\//.test(uri)) throw new Error('Enter a MongoDB connection URI.');
    await writeFile('backend/.env', `PORT=4000\nMONGODB_URI=${JSON.stringify(uri)}\nFRONTEND_URL=http://localhost:3000\nADMIN_PIN_HASH=${await hashPin(pin)}\nNODE_ENV=development\nTRUST_PROXY_HOPS=0\n`, {mode: 0o600, flag: 'wx'});
    try { await writeFile('frontend/.env.local', 'API_BASE_URL=http://127.0.0.1:4000\n', {flag: 'wx'}); } catch (e) { if (e.code !== 'EEXIST') throw e; }
    console.log('Configuration saved. Start MongoDB, then run npm run dev.');
  }
} finally { question.close(); }
