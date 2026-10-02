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
// The only Durable Object allowed is the library's own presence room, defined inside this Worker
// (no script_name), so it cannot reach any plugin object. Migrations may only create that class.
const objects = config.durable_objects?.bindings || [];
const presenceOnly = objects.length === 0 || (objects.length === 1 && objects[0].name === 'STUDIO_PRESENCE' &&
  objects[0].class_name === 'StudioPresence' && !objects[0].script_name && !objects[0].environment);
const migrationsOnly = (config.migrations || []).every(m => !m.deleted_classes && !m.renamed_classes && !m.transferred_classes &&
  !(m.new_classes || []).length && (m.new_sqlite_classes || []).every(name => name === 'StudioPresence'));
if (config.name !== expected.worker || config.account_id !== expected.account ||
    databases.length !== 1 || databases[0].binding !== 'DB' ||
    databases[0].database_name !== expected.worker || databases[0].database_id !== expected.database ||
    config.vars?.DB_DRIVER !== 'd1' || config.vars?.DB_CIPHER !== 'aes-256-gcm' ||
    config.services?.length || config.kv_namespaces?.length || config.r2_buckets?.length ||
    !presenceOnly || !migrationsOnly) {
  throw new Error('Deployment stopped: material library resource isolation does not match the approved configuration.');
}
console.log('Verified isolated material library Worker and D1; no plugin service bindings; only the library presence Durable Object.');
