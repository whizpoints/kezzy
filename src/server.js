import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.resolve(__dirname, '../public');

export function createHealthServer(getStatus) {
  const app = express();
  const PORT = process.env.PORT || 3000;

  app.use(express.json());

  // Render & Uptime robot health check endpoint
  app.get('/health', (req, res) => {
    res.status(200).send('OK');
  });

  // Serve static assets from public directory
  app.use(express.static(publicDir));

  // Catch-all: Any path/subpath displays the modern magazine editorial blog
  app.get('*', (req, res) => {
    res.sendFile(path.join(publicDir, 'index.html'));
  });

  const server = app.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 Modern blog & health service listening on port ${PORT} (0.0.0.0)`);
  });

  return server;
}
