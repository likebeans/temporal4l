import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const envPath = fileURLToPath(new URL('../.env', import.meta.url));
if (existsSync(envPath)) process.loadEnvFile(envPath);

export const config = {
  address: process.env.TEMPORAL_ADDRESS || '127.0.0.1:7233',
  namespace: process.env.TEMPORAL_NAMESPACE || 'temporal-learning',
  temporalUiUrl: process.env.TEMPORAL_UI_URL || 'http://localhost:8233',
  port: Number(process.env.API_PORT || 3001),
};
