import { startApp } from './server.ts';
const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL is required');
const app = await startApp({ databaseUrl, port: Number(process.env.PORT ?? 3000), host: process.env.HOST ?? '127.0.0.1' });
console.log(`Life Planner: ${app.url}`);
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => { void app.close().then(() => process.exit(0)); });
