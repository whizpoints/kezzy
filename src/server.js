import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.resolve(__dirname, '../public');

export function createHealthServer(getStatus) {
  const app = express();
  const PORT = process.env.PORT || 3000;

  app.use(express.json());

  // Serve modern camouflage landing page on root /
  app.use(express.static(publicDir));
  app.get('/', (req, res) => {
    res.sendFile(path.join(publicDir, 'index.html'));
  });

  // Render & Uptime robot health check endpoint
  app.get('/health', (req, res) => {
    res.status(200).send('OK');
  });

  const server = app.listen(PORT, () => {
    console.log(`🚀 Web service listening on port ${PORT}`);
  });

  return server;
}
