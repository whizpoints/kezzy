import { createClient } from '@libsql/client';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

let client = null;

export function initDb({ url, authToken }) {
  if (!url) {
    throw new Error('TURSO_DATABASE_URL is not defined in environment variables.');
  }

  client = createClient({
    url,
    authToken
  });

  return client;
}

export function getDb() {
  if (!client) {
    throw new Error('Database client not initialized. Call initDb() first.');
  }
  return client;
}

export async function runMigrations() {
  const schemaPath = path.resolve(__dirname, '../schema.sql');
  if (!fs.existsSync(schemaPath)) return;

  const sqlContent = fs.readFileSync(schemaPath, 'utf8');
  // Split individual statements by semicolon
  const statements = sqlContent
    .split(';')
    .map(s => s.trim())
    .filter(s => s.length > 0);

  for (const statement of statements) {
    await client.execute(statement);
  }

  // Ensure raw_message column exists in message_history for retry re-encryption
  try {
    await client.execute('ALTER TABLE message_history ADD COLUMN raw_message TEXT;');
  } catch (_) {}

  console.log('✅ Turso database schema verified / migrated successfully.');
}

// Helper to normalize SQLite numeric booleans (0 / 1)
function formatMapping(row) {
  if (!row) return null;
  return {
    wa_id: row.wa_id,
    tg_topic_id: Number(row.tg_topic_id),
    chat_name: row.chat_name,
    is_group: Boolean(row.is_group),
    is_announcement: Boolean(row.is_announcement),
    is_admin: Boolean(row.is_admin),
    created_at: row.created_at,
    updated_at: row.updated_at
  };
}

// ================= Chat Mappings ================= //

export async function getMappingByWaId(waId) {
  if (!waId) return null;
  const res = await client.execute({
    sql: 'SELECT * FROM chat_mappings WHERE wa_id = ? LIMIT 1',
    args: [waId]
  });
  if (res.rows[0]) return formatMapping(res.rows[0]);

  // Fallback: Check if this JID/LID has an alias in contacts table
  try {
    const contact = await getContact(waId);
    if (contact) {
      if (contact.lid && contact.lid !== waId) {
        const lidRes = await client.execute({
          sql: 'SELECT * FROM chat_mappings WHERE wa_id = ? LIMIT 1',
          args: [contact.lid]
        });
        if (lidRes.rows[0]) return formatMapping(lidRes.rows[0]);
      }

      if (contact.phone_number) {
        const pnJid = `${contact.phone_number}@s.whatsapp.net`;
        if (pnJid !== waId) {
          const pnRes = await client.execute({
            sql: 'SELECT * FROM chat_mappings WHERE wa_id = ? LIMIT 1',
            args: [pnJid]
          });
          if (pnRes.rows[0]) return formatMapping(pnRes.rows[0]);
        }
      }

      if (contact.wa_id && contact.wa_id !== waId) {
        const cRes = await client.execute({
          sql: 'SELECT * FROM chat_mappings WHERE wa_id = ? LIMIT 1',
          args: [contact.wa_id]
        });
        if (cRes.rows[0]) return formatMapping(cRes.rows[0]);
      }
    }
  } catch (_) {}

  return null;
}

export async function getMappingByTopicId(topicId) {
  const res = await client.execute({
    sql: 'SELECT * FROM chat_mappings WHERE tg_topic_id = ? LIMIT 1',
    args: [topicId]
  });
  return res.rows[0] ? formatMapping(res.rows[0]) : null;
}

export async function saveMapping({ waId, topicId, chatName, isGroup = false, isAnnouncement = false, isAdmin = false }) {
  const query = `
    INSERT INTO chat_mappings (wa_id, tg_topic_id, chat_name, is_group, is_announcement, is_admin, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(wa_id) 
    DO UPDATE SET 
      tg_topic_id = excluded.tg_topic_id,
      chat_name = excluded.chat_name,
      is_group = excluded.is_group,
      is_announcement = excluded.is_announcement,
      is_admin = excluded.is_admin,
      updated_at = CURRENT_TIMESTAMP;
  `;
  await client.execute({
    sql: query,
    args: [waId, topicId, chatName, isGroup ? 1 : 0, isAnnouncement ? 1 : 0, isAdmin ? 1 : 0]
  });

  return getMappingByWaId(waId);
}

export async function updateGroupStatus(waId, isAnnouncement, isAdmin) {
  await client.execute({
    sql: 'UPDATE chat_mappings SET is_announcement = ?, is_admin = ?, updated_at = CURRENT_TIMESTAMP WHERE wa_id = ?',
    args: [isAnnouncement ? 1 : 0, isAdmin ? 1 : 0, waId]
  });
  return getMappingByWaId(waId);
}

export async function getAllMappings() {
  const res = await client.execute('SELECT * FROM chat_mappings ORDER BY updated_at DESC');
  return res.rows.map(formatMapping);
}

export async function updateMappingName(waId, chatName) {
  await client.execute({
    sql: 'UPDATE chat_mappings SET chat_name = ?, updated_at = CURRENT_TIMESTAMP WHERE wa_id = ?',
    args: [chatName, waId]
  });
  return getMappingByWaId(waId);
}

// ================= Message History ================= //

export async function saveMessageHistory({
  waMessageId,
  tgMessageId,
  waChatId,
  tgTopicId,
  senderWaId,
  contentText,
  mediaType = 'text',
  rawMessage = null
}) {
  const query = `
    INSERT INTO message_history (wa_message_id, tg_message_id, wa_chat_id, tg_topic_id, sender_wa_id, content_text, media_type, raw_message)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?);
  `;
  const res = await client.execute({
    sql: query,
    args: [waMessageId, tgMessageId, waChatId, tgTopicId, senderWaId, contentText, mediaType, rawMessage]
  });
  return { id: res.lastInsertRowid, waMessageId, tgMessageId };
}

export async function getMessageHistoryByTgId(tgMessageId) {
  const res = await client.execute({
    sql: 'SELECT * FROM message_history WHERE tg_message_id = ? LIMIT 1',
    args: [tgMessageId]
  });
  return res.rows[0] || null;
}

export async function getMessageHistoryByWaId(waMessageId) {
  const res = await client.execute({
    sql: 'SELECT * FROM message_history WHERE wa_message_id = ? LIMIT 1',
    args: [waMessageId]
  });
  return res.rows[0] || null;
}

export async function hasProfileCardBeenPinned(topicId) {
  if (!topicId) return false;
  try {
    const res = await client.execute({
      sql: "SELECT 1 FROM message_history WHERE tg_topic_id = ? AND media_type = 'profile_card' LIMIT 1",
      args: [topicId]
    });
    return res.rows.length > 0;
  } catch (_) {
    return false;
  }
}

// ================= Contacts ================= //

export async function saveContact({ waId, name, phoneNumber = null, lid = null }) {
  if (!waId) return;

  // Normalize waId (strip device suffixes like :10@...)
  const cleanWaId = waId.includes('@')
    ? `${waId.split('@')[0].split(':')[0]}@${waId.split('@')[1]}`
    : waId;

  const cleanLid = lid && lid.includes('@')
    ? `${lid.split('@')[0].split(':')[0]}@${lid.split('@')[1]}`
    : (lid ? `${lid.split(':')[0]}@lid` : null);

  const cleanPhone = phoneNumber ? String(phoneNumber).replace(/[^\d]/g, '') : null;
  const validName = name && name.trim() ? name.trim() : null;

  const query = `
    INSERT INTO contacts (wa_id, name, phone_number, lid, updated_at)
    VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(wa_id) 
    DO UPDATE SET 
      name = CASE 
        WHEN contacts.name IS NOT NULL 
             AND contacts.name != '' 
             AND contacts.name NOT LIKE 'WhatsApp Contact%' 
             AND contacts.name NOT LIKE 'WhatsApp User%'
             AND contacts.name NOT LIKE 'Contact %'
             AND contacts.name NOT LIKE '+%'
        THEN contacts.name 
        ELSE COALESCE(excluded.name, contacts.name) 
      END,
      phone_number = COALESCE(excluded.phone_number, contacts.phone_number),
      lid = COALESCE(excluded.lid, contacts.lid),
      updated_at = CURRENT_TIMESTAMP;
  `;
  await client.execute({
    sql: query,
    args: [cleanWaId, validName, cleanPhone, cleanLid]
  });

  // If lid is present and different from cleanWaId, also index by cleanLid so reverse lookup works instantly
  if (cleanLid && cleanLid !== cleanWaId) {
    await client.execute({
      sql: query,
      args: [cleanLid, validName, cleanPhone, cleanLid]
    });
  }

  // Cross-save by phone JID if available
  if (cleanPhone) {
    const pnJid = `${cleanPhone}@s.whatsapp.net`;
    if (pnJid !== cleanWaId && pnJid !== cleanLid) {
      await client.execute({
        sql: query,
        args: [pnJid, validName, cleanPhone, cleanLid]
      });
    }
  }
}

export async function getContact(jidOrLid) {
  if (!jidOrLid) return null;
  const raw = String(jidOrLid).trim();
  const cleanId = raw.includes('@')
    ? `${raw.split('@')[0].split(':')[0]}@${raw.split('@')[1]}`
    : raw.split(':')[0];
  const digits = raw.replace(/[^\d]/g, '');

  let query = `
    SELECT * FROM contacts 
    WHERE wa_id = ? OR lid = ? OR wa_id = ? OR lid = ?
  `;
  const args = [raw, raw, cleanId, cleanId];

  if (digits && digits.length >= 6) {
    query += ` OR phone_number = ? OR wa_id = ? OR wa_id LIKE ?`;
    args.push(digits, `${digits}@s.whatsapp.net`, `%${digits}%`);
  }

  query += ` ORDER BY 
    (CASE 
      WHEN name IS NOT NULL AND name != '' AND name NOT LIKE 'WhatsApp%' AND name NOT LIKE 'Contact %' AND name NOT LIKE '+%' THEN 3
      WHEN name IS NOT NULL AND name != '' THEN 2
      ELSE 0 
    END) DESC,
    (CASE WHEN wa_id LIKE '%@s.whatsapp.net' THEN 1 ELSE 0 END) DESC,
    updated_at DESC LIMIT 1`;

  const res = await client.execute({ sql: query, args });
  return res.rows[0] || null;
}

export async function getContactsWithPhone() {
  const res = await client.execute({
    sql: "SELECT * FROM contacts WHERE phone_number IS NOT NULL AND phone_number != '' AND (lid IS NULL OR lid = '')"
  });
  return res.rows;
}

export async function updateContactLid(phoneOrWaId, lid) {
  if (!lid) return;
  const cleanLid = lid.includes('@')
    ? `${lid.split('@')[0].split(':')[0]}@${lid.split('@')[1]}`
    : `${lid.split(':')[0]}@lid`;

  await client.execute({
    sql: `UPDATE contacts SET lid = ?, updated_at = CURRENT_TIMESTAMP 
          WHERE phone_number = ? OR wa_id = ? OR wa_id LIKE ?`,
    args: [cleanLid, phoneOrWaId, phoneOrWaId, `%${phoneOrWaId}%`]
  });
}

export async function searchContacts(queryText) {
  const res = await client.execute({
    sql: `SELECT * FROM contacts 
          WHERE name LIKE ? OR phone_number LIKE ? 
          ORDER BY updated_at DESC LIMIT 10`,
    args: [`%${queryText}%`, `%${queryText}%`]
  });
  return res.rows;
}

/**
 * Automatically seed extracted WhatsApp contacts from contacts.json into Turso DB
 */
export async function seedContactsFromFile() {
  try {
    const contactsPath = path.resolve(__dirname, 'data/contacts.json');
    if (!fs.existsSync(contactsPath)) return 0;

    const rawContacts = JSON.parse(fs.readFileSync(contactsPath, 'utf8'));
    if (!Array.isArray(rawContacts) || rawContacts.length === 0) return 0;

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

    const statements = [];
    for (const c of uniqueContacts) {
      const phoneJid = c.phone ? `${c.phone}@s.whatsapp.net` : null;
      const lidJid = c.lid ? `${c.lid}@lid` : null;
      const name = c.name || (c.phone ? `Contact ${c.phone.slice(-4)}` : 'WhatsApp Contact');
      const phone = c.phone || null;

      if (phoneJid) statements.push({ sql: query, args: [phoneJid, name, phone, lidJid] });
      if (lidJid) statements.push({ sql: query, args: [lidJid, name, phone, lidJid] });
      if (phone) statements.push({ sql: query, args: [phone, name, phone, lidJid] });
    }

    const chunkSize = 100;
    for (let i = 0; i < statements.length; i += chunkSize) {
      const chunk = statements.slice(i, i + chunkSize);
      await client.batch(chunk, 'write');
    }

    console.log(`✅ Loaded & verified ${uniqueContacts.length} contacts from contacts.json into Turso DB.`);
    return uniqueContacts.length;
  } catch (err) {
    console.warn('Contacts auto-seed notice:', err.message);
    return 0;
  }
}
