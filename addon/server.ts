import * as express from 'express';
import { startServerWithCacheWarming } from './index.js';
import { initializeMapper } from './lib/id-mapper.js';
import { initializeAnimeListMapper } from './lib/anime-list-mapper.js';
import { initializeMappings } from './lib/wiki-mapper.js';
import { runCacheCleanup } from './cache-cleanup.js';
import { runCachePathMigration } from './lib/cache-path-migration.js';
import database from './lib/database.js';
import consola from 'consola';

const app = express();
let initialized = false;

async function initOnce() {
  if (initialized) return;
  consola.info('--- Addon Initialization ---');

  try {
    await runCachePathMigration();
    await initializeMapper();
    await initializeAnimeListMapper();
    await initializeMappings();
    await database.initialize();
    await runCacheCleanup();
    await startServerWithCacheWarming();
    initialized = true;
    consola.success('--- Addon Initialization Complete ---');
  } catch (err: any) {
    consola.error('--- Initialization Failed ---', err);
    throw err;
  }
}

// Example endpoints
app.get('/ping', async (_req, res) => {
  await initOnce();
  res.send('pong');
});

app.get('/manifest.json', async (_req, res) => {
  await initOnce();
  res.json({ id: 'aiometadata', name: 'AIOMetadata' });
});

app.get('/request_token', async (_req, res) => {
  await initOnce();
  res.json({ token: 'dummy-token' });
});

app.all('*', async (_req, res) => {
  await initOnce();
  res.status(404).send('Not found');
});

export default app;
