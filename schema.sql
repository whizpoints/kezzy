-- Database schema for WhatsApp-Telegram Bridge (Turso / libSQL / SQLite)

-- 1. WhatsApp Baileys Auth Session State
CREATE TABLE IF NOT EXISTS wa_auth_sessions (
    session_id TEXT NOT NULL,
    key_id TEXT NOT NULL,
    value TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (session_id, key_id)
);
CREATE INDEX IF NOT EXISTS idx_wa_auth_session ON wa_auth_sessions(session_id);

-- 2. Chat Mappings (WhatsApp Chat/Group <-> Telegram Forum Topic)
CREATE TABLE IF NOT EXISTS chat_mappings (
    wa_id TEXT PRIMARY KEY,
    tg_topic_id INTEGER NOT NULL UNIQUE,
    chat_name TEXT NOT NULL,
    is_group INTEGER DEFAULT 0,
    is_announcement INTEGER DEFAULT 0,
    is_admin INTEGER DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_chat_mappings_topic ON chat_mappings(tg_topic_id);

-- 3. Message History (For native quoted replies and reference)
CREATE TABLE IF NOT EXISTS message_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    wa_message_id TEXT,
    tg_message_id INTEGER NOT NULL,
    wa_chat_id TEXT NOT NULL,
    tg_topic_id INTEGER NOT NULL,
    sender_wa_id TEXT,
    content_text TEXT,
    media_type TEXT DEFAULT 'text',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_msg_history_wa_id ON message_history(wa_message_id);
CREATE INDEX IF NOT EXISTS idx_msg_history_tg_id ON message_history(tg_message_id);
CREATE INDEX IF NOT EXISTS idx_msg_history_chat ON message_history(wa_chat_id, created_at DESC);

-- 4. Synced WhatsApp Contacts
CREATE TABLE IF NOT EXISTS contacts (
    wa_id TEXT PRIMARY KEY,
    name TEXT,
    phone_number TEXT,
    lid TEXT,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_contacts_name ON contacts(name);
CREATE INDEX IF NOT EXISTS idx_contacts_lid ON contacts(lid);
