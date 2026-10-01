import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const config = JSON.parse(fs.readFileSync(path.join(root, 'wrangler.jsonc'), 'utf8'));
const expected = {
  worker: 'xczstudio-openlist-trial',
  account: 'cc439d00213ab3c2cddc9285ef04a983',
  database: '7580e77d-5f66-4719-b9ba-953b526fe331',
};
const databases = config.d1_databases || [];
if (config.name !== expected.worker || config.account_id !== expected.account ||
    databases.length !== 1 || databases[0].binding !== 'DB' ||
    databases[0].database_name !== expected.worker || databases[0].database_id !== expected.database ||
    config.vars?.DB_DRIVER !== 'd1' || config.vars?.DB_CIPHER !== 'aes-256-gcm' ||
    config.services?.length || config.kv_namespaces?.length || config.r2_buckets?.length ||
    config.durable_objects?.bindings?.length) {
  throw new Error('Deployment stopped: material library resource isolation does not match the approved configuration.');
}
console.log('Verified isolated material library Worker and D1; no plugin service bindings.');
