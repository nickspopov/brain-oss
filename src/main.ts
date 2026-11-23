// Server entry point: config → DB → migrations → core → adapters → listen.
import { createApp } from './app.js';
import { loadConfig } from './config.js';
import { hasSuperadmin } from './core/principals.js';

async function main(): Promise<void> {
  const config = loadConfig();
  const app = createApp(config);
  if (!hasSuperadmin(app.core)) {
    app.core.log.warn('no superadmin yet: run `npm run brain -- admin create --name <name>`; until then every route except /healthz answers 503');
  }
  const shutdown = async (): Promise<void> => {
    await app.close();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown());
  process.on('SIGTERM', () => void shutdown());
  await app.server.listen({ host: config.host, port: config.port });
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
