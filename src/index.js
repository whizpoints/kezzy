import 'dotenv/config';
import { initDb, runMigrations, getDb, seedContactsFromFile } from './db.js';
import { createHealthServer } from './server.js';
import { initTelegramBot } from './telegram.js';
import { initWhatsApp, getWaSocket, getWaStatus, relinkWhatsApp, getLatestQr, getAuthCleanup } from './whatsapp.js';

// Prevent transient network errors or unhandled rejections from crashing the process
process.on('unhandledRejection', (reason) => {
  console.error('⚠️ Unhandled Promise Rejection (Process protected):', reason?.message || reason);
});

process.on('uncaughtException', (err) => {
  console.error('⚠️ Uncaught Exception (Process protected):', err?.message || err);
});

async function main() {
  console.log('🚀 Starting WhatsApp-Telegram Bridge (Powered by Turso)...');

  const {
    TELEGRAM_BOT_TOKEN,
    TELEGRAM_GROUP_ID,
    TURSO_DATABASE_URL,
    DATABASE_URL,
    TURSO_AUTH_TOKEN,
    SESSION_ID = 'main_wa_session',
    GENERAL_TOPIC_ID = '1'
  } = process.env;

  const dbUrl = TURSO_DATABASE_URL || DATABASE_URL;

  if (!TELEGRAM_BOT_TOKEN) {
    console.error('❌ Missing TELEGRAM_BOT_TOKEN in environment variables.');
    process.exit(1);
  }

  if (!TELEGRAM_GROUP_ID) {
    console.error('❌ Missing TELEGRAM_GROUP_ID in environment variables.');
    process.exit(1);
  }

  if (!dbUrl) {
    console.error('❌ Missing TURSO_DATABASE_URL in environment variables.');
    process.exit(1);
  }

  // 1. Start Health & Decoy Blog Server Immediately (Render Web Service requirement)
  createHealthServer(
    () => ({
      waConnected: getWaStatus().connected,
      user: getWaStatus().userJid
    }),
    getLatestQr
  );

  // 2. Initialize Turso Edge SQLite Database & run migrations
  console.log('📦 Connecting to Turso database at:', dbUrl);
  const dbClient = initDb({
    url: dbUrl,
    authToken: TURSO_AUTH_TOKEN
  });
  await runMigrations();
  await seedContactsFromFile();

  // 3. Initialize Telegram Bot
  console.log('🤖 Initializing Telegram bot...');
  let bot = null;
  bot = initTelegramBot({
    botToken: TELEGRAM_BOT_TOKEN,
    groupId: TELEGRAM_GROUP_ID,
    generalTopicId: parseInt(GENERAL_TOPIC_ID, 10) || 1,
    getWaSocket,
    getWaStatus,
    onRelink: () =>
      relinkWhatsApp({
        client: dbClient,
        sessionId: SESSION_ID,
        bot,
        groupId: TELEGRAM_GROUP_ID,
        generalTopicId: parseInt(GENERAL_TOPIC_ID, 10) || 1
      })
  });

  // Launch Telegram polling
  bot.launch({
    allowedUpdates: ['message', 'edited_message', 'callback_query']
  }).then(() => {
    console.log('⚡ Telegram bot polling started successfully.');
  }).catch((err) => {
    console.error('❌ Failed to start Telegram bot:', err);
  });

  // 4. Initialize WhatsApp Connection via Baileys & Turso auth adapter
  console.log('📱 Connecting to WhatsApp via Baileys...');
  await initWhatsApp({
    client: dbClient,
    sessionId: SESSION_ID,
    bot,
    groupId: TELEGRAM_GROUP_ID,
    generalTopicId: parseInt(GENERAL_TOPIC_ID, 10) || 1
  });

  // Graceful shutdown handling
  const shutdown = async (signal) => {
    console.log(`\n🛑 Received ${signal}. Shutting down gracefully...`);
    try {
      bot.stop(signal);
      const sock = getWaSocket();
      if (sock) {
        sock.end();
      }
      const authCleanup = getAuthCleanup();
      if (authCleanup?.flushRemaining) {
        console.log('💾 Flushing pending session keys to Turso before shutdown...');
        await authCleanup.flushRemaining();
      }
      const client = getDb();
      if (client && client.close) {
        client.close();
      }
      console.log('👋 All connections closed cleanly.');
    } catch (err) {
      console.error('Error during shutdown:', err);
    } finally {
      process.exit(0);
    }
  };

  process.once('SIGINT', () => shutdown('SIGINT'));
  process.once('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch((err) => {
  console.error('💥 Fatal error during initialization:', err);
  process.exit(1);
});
