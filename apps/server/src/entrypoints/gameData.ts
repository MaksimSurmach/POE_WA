import { createDatabasePool } from '../database.js';
import { createGameDataRepository, loadGameDataSource } from '../gameData.js';
import { loadDatabaseConfig } from '../config.js';

const [command, value] = process.argv.slice(2);
if (!command || !value || !['import', 'activate', 'validate'].includes(command))
  throw new Error(
    'Usage: game-data <import|validate|activate> <source-path|version-id>',
  );
const pool = createDatabasePool(loadDatabaseConfig());
try {
  const repository = createGameDataRepository(pool);
  if (command === 'activate') await repository.activate(value);
  else {
    const source = await loadGameDataSource(value);
    if (command === 'validate') console.log('Game-data source is valid');
    else console.log(await repository.import(source));
  }
} finally {
  await pool.end();
}
