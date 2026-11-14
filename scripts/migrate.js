// Applies any database migrations that haven't run yet (see MIGRATIONS in lib/store.js).
// The app also does this on its first database call, so this is for running them ahead of a deploy.
//   npm run migrate
import { store } from '../lib/store.js';

if (store.kind !== 'postgres') {
  console.log('No DATABASE_URL set: the local file store needs no migrations.');
  process.exit(0);
}
const applied = await store.migrate();
console.log(applied.length ? `Applied migrations: ${applied.join(', ')}` : 'Database is up to date.');
