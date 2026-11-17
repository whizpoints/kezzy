import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.resolve(__dirname, '../public');

export function createHealthServer(getStatus, getQrData) {
  const app = express();
  const PORT = process.env.PORT || 3000;

  app.use(express.json());

  // 1. Render & Uptime health check endpoint
  app.get('/health', (req, res) => {
    res.status(200).send('OK');
  });

  // 2. Real-time API status endpoint
  app.get('/api/status', (req, res) => {
    const status = getStatus ? getStatus() : {};
    const qrInfo = getQrData ? getQrData() : {};
    res.json({
      ok: true,
      uptime: Math.floor(process.uptime()),
      waConnected: !!status.waConnected,
      user: status.user || null,
      hasQr: !!qrInfo.qrString
    });
  });

  // 3. Raw QR image endpoint
  app.get('/qr.png', (req, res) => {
    const qrInfo = getQrData ? getQrData() : {};
    if (qrInfo.qrBuffer) {
      res.setHeader('Content-Type', 'image/png');
      res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, private');
      return res.send(qrInfo.qrBuffer);
    }
    res.status(404).send('No active QR code generated.');
  });

  // 4. Live interactive QR linking dashboard with auto-polling
  app.get('/qr', (req, res) => {
    const status = getStatus ? getStatus() : {};
    const qrInfo = getQrData ? getQrData() : {};

    const cleanUser = status.user ? status.user.split(':')[0] : '';
    const isConnected = !!status.waConnected;
    const hasQr = !!qrInfo.qrString;

    const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>WhatsApp Bridge | Device Pairing</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;500;600;700&display=swap" rel="stylesheet">
  <style>
    :root {
      --bg: #0b0f19;
      --card-bg: #111827;
      --border: rgba(255, 255, 255, 0.08);
      --accent: #25d366;
      --text: #f3f4f6;
      --text-muted: #9ca3af;
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      background: var(--bg);
      color: var(--text);
      font-family: 'Plus Jakarta Sans', sans-serif;
      min-height: 100vh;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      padding: 1.5rem;
    }
    .card {
      background: var(--card-bg);
      border: 1px solid var(--border);
      border-radius: 20px;
      padding: 2.5rem 2rem;
      max-width: 440px;
      width: 100%;
      text-align: center;
      box-shadow: 0 20px 40px rgba(0, 0, 0, 0.4);
    }
    .logo {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 54px;
      height: 54px;
      background: rgba(37, 211, 102, 0.12);
      border-radius: 16px;
      margin-bottom: 1.25rem;
      color: var(--accent);
    }
    h1 {
      font-size: 1.45rem;
      font-weight: 700;
      margin-bottom: 0.5rem;
      letter-spacing: -0.01em;
    }
    p.subtitle {
      font-size: 0.92rem;
      color: var(--text-muted);
      margin-bottom: 1.75rem;
      line-height: 1.5;
    }
    .qr-container {
      background: #ffffff;
      padding: 1rem;
      border-radius: 16px;
      display: inline-block;
      margin-bottom: 1.5rem;
      box-shadow: 0 8px 24px rgba(0,0,0,0.25);
    }
    .qr-container img {
      display: block;
      width: 250px;
      height: 250px;
      image-rendering: pixelated;
    }
    .instructions {
      text-align: left;
      background: rgba(255, 255, 255, 0.03);
      border: 1px solid var(--border);
      border-radius: 12px;
      padding: 1rem 1.25rem;
      font-size: 0.86rem;
      color: var(--text-muted);
      line-height: 1.6;
      margin-bottom: 1.25rem;
    }
    .instructions ol {
      margin-left: 1.25rem;
    }
    .instructions li {
      margin-bottom: 0.25rem;
    }
    .instructions b {
      color: var(--text);
    }
    .status-badge {
      display: inline-flex;
      align-items: center;
      gap: 0.5rem;
      font-size: 0.85rem;
      font-weight: 600;
      padding: 0.4rem 0.9rem;
      border-radius: 50px;
      background: rgba(255, 255, 255, 0.05);
      color: var(--text-muted);
    }
    .status-badge.online {
      background: rgba(37, 211, 102, 0.15);
      color: #25d366;
    }
    .status-badge.waiting {
      background: rgba(234, 179, 8, 0.15);
      color: #eab308;
    }
    .dot {
      width: 8px;
      height: 8px;
      border-radius: 50%;
      background: currentColor;
    }
    .spinner {
      border: 3px solid rgba(255, 255, 255, 0.1);
      border-top-color: var(--accent);
      border-radius: 50%;
      width: 32px;
      height: 32px;
      animation: spin 1s linear infinite;
      margin: 2rem auto;
    }
    @keyframes spin {
      to { transform: rotate(360deg); }
    }
  </style>
</head>
<body>
  <div class="card" id="mainCard">
    <div class="logo">
      <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
        <path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z"></path>
      </svg>
    </div>
    <h1>WhatsApp Bridge</h1>
    <p class="subtitle" id="subText">Scan to link your account to Telegram</p>

    <div id="contentArea">
      ${
        isConnected
          ? `
          <div style="padding: 2rem 0;">
            <div class="status-badge online" style="font-size: 1rem; padding: 0.6rem 1.25rem; margin-bottom: 1rem;">
              <span class="dot"></span> Connected
            </div>
            <p style="font-size: 0.95rem; color: var(--text);">Account: <b>+${cleanUser}</b></p>
            <p style="font-size: 0.85rem; color: var(--text-muted); margin-top: 0.5rem;">Bridge is active and routing messages.</p>
          </div>
        `
          : hasQr
          ? `
          <div class="qr-container">
            <img id="qrImg" src="/qr.png?t=${Date.now()}" alt="WhatsApp QR Code">
          </div>
          <div class="instructions">
            <ol>
              <li>Open <b>WhatsApp</b> on your phone</li>
              <li>Tap <b>Menu</b> or <b>Settings &gt; Linked Devices</b></li>
              <li>Tap <b>Link a Device</b> and point your phone at this screen</li>
            </ol>
          </div>
          <div class="status-badge waiting">
            <span class="dot"></span> Waiting for scan...
          </div>
        `
          : `
          <div style="padding: 2rem 0;">
            <div class="spinner"></div>
            <p style="font-size: 0.9rem; color: var(--text-muted);">Generating WhatsApp pairing QR code...</p>
          </div>
        `
      }
    </div>
  </div>

  <script>
    let currentConnected = ${isConnected};
    let currentHasQr = ${hasQr};

    async function pollStatus() {
      try {
        const res = await fetch('/api/status');
        if (!res.ok) return;
        const data = await res.json();

        if (data.waConnected !== currentConnected || data.hasQr !== currentHasQr) {
          location.reload();
          return;
        }

        // If waiting for QR, refresh QR image periodically
        const qrImg = document.getElementById('qrImg');
        if (qrImg && data.hasQr && !data.waConnected) {
          qrImg.src = '/qr.png?t=' + Date.now();
        }
      } catch (_) {}
    }

    setInterval(pollStatus, 3000);
  </script>
</body>
</html>`;

    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(html);
  });

  // 5. Serve static assets from public directory
  app.use(express.static(publicDir));

  // 6. Catch-all: Decoy blog for all other routes
  app.get('*', (req, res) => {
    res.sendFile(path.join(publicDir, 'index.html'));
  });

  const server = app.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 Modern blog & health service listening on port ${PORT} (0.0.0.0)`);

    // Keep Render Free Tier awake by self-pinging the public router every 8 minutes
    const externalUrl = process.env.RENDER_EXTERNAL_URL || process.env.APP_URL;
    if (externalUrl) {
      console.log(`⏰ Initializing anti-sleep keep-alive pinger for: ${externalUrl}`);
      setInterval(async () => {
        try {
          const res = await fetch(`${externalUrl.replace(/\/$/, '')}/health`);
          if (res.ok) {
            console.log('💓 Anti-sleep heartbeat ping successful');
          }
        } catch (pingErr) {
          console.warn('Anti-sleep heartbeat ping note:', pingErr.message);
        }
      }, 8 * 60 * 1000); // Every 8 minutes (Render sleeps at 15 mins)
    }
  });

  return server;
}
