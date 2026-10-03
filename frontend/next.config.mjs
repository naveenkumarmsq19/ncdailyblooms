import path from 'node:path';
import {fileURLToPath} from 'node:url';

const config = {
  // Browser calls stay on the frontend origin, including session cookies.
  async rewrites() {
    const api = (process.env.API_BASE_URL || 'http://127.0.0.1:4000').replace(/\/$/, '');
    return [{source: '/api/:path*', destination: `${api}/api/:path*`}];
  },
  outputFileTracingRoot: path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'),
  poweredByHeader: false,
};
export default config;
