import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { Telegraf } from 'telegraf';
import { initDb, getDb, getAllMappings, updateMappingName } from '../src/db.js';
import { sanitizeTopicName } from '../src/media.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

async function main() {
  console.log('🚀 Starting Fast Contacts Seeder & Topic Updater...');

  const dbUrl = process.env.TURSO_DATABASE_URL;
  const dbAuthToken = process.env.TURSO_AUTH_TOKEN;
  const botToken = process.env.TELEGRAM_BOT_TOKEN;
  const groupId = process.env.TELEGRAM_GROUP_ID;

  if (!dbUrl || !botToken || !groupId) {
    throw new Error('TURSO_DATABASE_URL, TELEGRAM_BOT_TOKEN, and TELEGRAM_GROUP_ID are required in .env');
  }

  initDb({ url: dbUrl, authToken: dbAuthToken });
  const db = getDb();
  const bot = new Telegraf(botToken);

  const contactsPath = path.resolve(__dirname, '../src/data/contacts.json');
  if (!fs.existsSync(contactsPath)) {
    throw new Error(`contacts.json not found at ${contactsPath}`);
  }

  const rawContacts = JSON.parse(fs.readFileSync(contactsPath, 'utf8'));
  console.log(`📂 Read ${rawContacts.length} raw contact records from contacts.json`);

  const contactMap = new Map();

  for (const c of rawContacts) {
    const user = c.id?.user;
    const server = c.id?.server;
    const num = c.number;
    const rawName = c.name || c.shortName || c.pushname || null;

    let phone = null;
    let lid = null;

    if (server === 'c.us' && user) phone = user;
    if (server === 'lid' && user) lid = user;

    if (num) {
      if (num.length >= 14) lid = num;
      else if (num.length >= 8 && num.length <= 13) phone = num;
    }

    const key = phone || lid;
    if (!key) continue;

    const entry = contactMap.get(key) || { phone: null, lid: null, name: null, pushname: null };
    if (phone) entry.phone = phone;
    if (lid) entry.lid = lid;
    if (rawName && (!entry.name || entry.name.startsWith('+'))) {
      entry.name = rawName;
    }
    if (c.pushname && !entry.pushname) {
      entry.pushname = c.pushname;
    }

    contactMap.set(key, entry);
    if (entry.phone) contactMap.set(entry.phone, entry);
    if (entry.lid) contactMap.set(entry.lid, entry);
  }

  const uniqueContacts = Array.from(new Set(contactMap.values()));
  console.log(`✅ Consolidating ${uniqueContacts.length} unique contacts with phone/LID mappings.`);

  // Prepare batch statements
  const statements = [];
  const query = `
    INSERT INTO contacts (wa_id, name, phone_number, lid, updated_at)
    VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(wa_id) 
    DO UPDATE SET 
      name = COALESCE(excluded.name, contacts.name),
      phone_number = COALESCE(excluded.phone_number, contacts.phone_number),
      lid = COALESCE(excluded.lid, contacts.lid),
      updated_at = CURRENT_TIMESTAMP;
  `;

  for (const c of uniqueContacts) {
    const phoneJid = c.phone ? `${c.phone}@s.whatsapp.net` : null;
    const lidJid = c.lid ? `${c.lid}@lid` : null;
    const name = c.name || (c.phone ? `Contact ${c.phone.slice(-4)}` : 'WhatsApp Contact');
    const phone = c.phone || null;

    if (phoneJid) {
      statements.push({ sql: query, args: [phoneJid, name, phone, lidJid] });
    }
    if (lidJid) {
      statements.push({ sql: query, args: [lidJid, name, phone, lidJid] });
    }
    if (phone) {
      statements.push({ sql: query, args: [phone, name, phone, lidJid] });
    }
  }

  console.log(`⚡ Executing ${statements.length} statements in fast batches...`);
  const chunkSize = 100;
  for (let i = 0; i < statements.length; i += chunkSize) {
    const chunk = statements.slice(i, i + chunkSize);
    await db.batch(chunk, 'write');
    console.log(`  Uploaded batch ${Math.floor(i / chunkSize) + 1}/${Math.ceil(statements.length / chunkSize)}`);
  }
  console.log('💾 All contacts saved to Turso database successfully!');

  // 2. Audit and update all existing Telegram topics
  const mappings = await getAllMappings();
  console.log(`🔍 Auditing ${mappings.length} topics in group ${groupId}...`);

  for (const m of mappings) {
    if (m.wa_id === '__storage_media__' || m.wa_id === '0@s.whatsapp.net' || m.is_group) {
      continue;
    }

    const cleanWaId = m.wa_id.split('@')[0];
    const match = contactMap.get(cleanWaId);

    if (match && match.name) {
      const phoneDisplay = match.phone ? ` (+${match.phone})` : '';
      const newTitle = sanitizeTopicName(`${match.name}${phoneDisplay}`);

      if (m.chat_name !== newTitle) {
        try {
          console.log(`✏️ Renaming topic ${m.tg_topic_id}: "${m.chat_name}" -> "${newTitle}"...`);
          await bot.telegram.editForumTopic(groupId, m.tg_topic_id, { name: newTitle });
          await updateMappingName(m.wa_id, newTitle);
          console.log(`✅ Topic ${m.tg_topic_id} renamed to: "${newTitle}"`);
          await new Promise(r => setTimeout(r, 600)); // Rate limit pause
        } catch (err) {
          if (err.description?.includes('TOPIC_NOT_MODIFIED')) {
            await updateMappingName(m.wa_id, newTitle);
          } else {
            console.warn(`Could not rename topic ${m.tg_topic_id}:`, err.message);
          }
        }
      } else {
        console.log(`Topic ${m.tg_topic_id} is already correctly named "${m.chat_name}".`);
      }
    }
  }

  console.log('🎉 Seeding and topic title updates completed successfully!');
}

main().catch(err => {
  console.error('Fatal error in seedContacts:', err);
  process.exit(1);
});
