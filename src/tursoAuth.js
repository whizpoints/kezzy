import { initAuthCreds, BufferJSON, proto } from '@whiskeysockets/baileys';

/**
 * High-Performance In-Memory Cached & Debounced Turso Auth Adapter for Baileys
 * 
 * Features:
 * - 100% In-Memory Reads: Keys are retrieved at 0ms RAM speed.
 * - Instant Creds Persistence: Credentials write immediately to Turso so pairing is reliable.
 * - Clean teardown & cleanup on session resets.
 * - Serialized Background Flush Queue: Never overwhelms Turso with parallel HTTPS requests.
 * - Prevents event-loop starvation and WhatsApp 428 (connectionLost) disconnects.
 * - Completely persists session across restarts to Turso.
 */
export async function useTursoAuthState(client, sessionId = 'main_wa_session') {
  const memoryCache = new Map();
  const pendingKeyWrites = new Map();
  let credsDirty = false;
  let isFlushing = false;
  let isCleanedUp = false;

  // 1. Fetch credentials from Turso on startup
  const credsRes = await client.execute({
    sql: 'SELECT value FROM wa_auth_sessions WHERE session_id = ? AND key_id = ? LIMIT 1',
    args: [sessionId, 'creds']
  });

  let creds;
  if (credsRes.rows.length > 0) {
    creds = JSON.parse(credsRes.rows[0].value, BufferJSON.reviver);
  } else {
    creds = initAuthCreds();
  }

  // Serialized background flush worker
  const flushToTurso = async () => {
    if (isCleanedUp || isFlushing) return;
    if (!credsDirty && pendingKeyWrites.size === 0) return;

    isFlushing = true;
    try {
      // 1. Flush creds if dirty
      if (credsDirty) {
        credsDirty = false;
        const serializedCreds = JSON.stringify(creds, BufferJSON.replacer);
        await client.execute({
          sql: `INSERT INTO wa_auth_sessions (session_id, key_id, value, updated_at)
                VALUES (?, 'creds', ?, CURRENT_TIMESTAMP)
                ON CONFLICT(session_id, key_id) 
                DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP`,
          args: [sessionId, serializedCreds]
        });
      }

      // 2. Flush pending keys in batches of up to 150 statements
      if (pendingKeyWrites.size > 0) {
        const batchKeys = Array.from(pendingKeyWrites.keys()).slice(0, 150);
        const statements = [];

        for (const keyId of batchKeys) {
          const val = pendingKeyWrites.get(keyId);
          pendingKeyWrites.delete(keyId);

          if (val) {
            statements.push({
              sql: `INSERT INTO wa_auth_sessions (session_id, key_id, value, updated_at)
                    VALUES (?, ?, ?, CURRENT_TIMESTAMP)
                    ON CONFLICT(session_id, key_id) 
                    DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP`,
              args: [sessionId, keyId, val]
            });
          } else {
            statements.push({
              sql: 'DELETE FROM wa_auth_sessions WHERE session_id = ? AND key_id = ?',
              args: [sessionId, keyId]
            });
          }
        }

        if (statements.length > 0) {
          await client.batch(statements, 'write');
        }
      }
    } catch (err) {
      if (!isCleanedUp) {
        console.warn('⚠️ Turso background sync warning:', err.message);
      }
    } finally {
      isFlushing = false;
    }
  };

  const flushInterval = setInterval(flushToTurso, 800);
  flushInterval.unref();

  return {
    state: {
      creds,
      keys: {
        get: async (type, ids) => {
          const data = {};
          if (!ids || ids.length === 0) return data;

          const missingIds = [];

          // 1. Instant RAM lookup
          for (const id of ids) {
            const cacheKey = `${type}-${id}`;
            if (memoryCache.has(cacheKey)) {
              let val = memoryCache.get(cacheKey);
              if (type === 'app-state-sync-key' && val) {
                val = proto.Message.AppStateSyncKeyData.fromObject(val);
              }
              data[id] = val;
            } else {
              missingIds.push(id);
            }
          }

          // 2. Fetch missing keys from Turso only if not in RAM
          if (missingIds.length > 0 && !isCleanedUp) {
            try {
              const placeholders = missingIds.map(() => '?').join(',');
              const keyIds = missingIds.map(id => `${type}-${id}`);

              const res = await client.execute({
                sql: `SELECT key_id, value FROM wa_auth_sessions WHERE session_id = ? AND key_id IN (${placeholders})`,
                args: [sessionId, ...keyIds]
              });

              for (const row of res.rows) {
                const rawId = row.key_id.substring(type.length + 1);
                let parsed = JSON.parse(row.value, BufferJSON.reviver);
                if (type === 'app-state-sync-key' && parsed) {
                  parsed = proto.Message.AppStateSyncKeyData.fromObject(parsed);
                }
                memoryCache.set(row.key_id, parsed);
                data[rawId] = parsed;
              }
            } catch (err) {
              console.warn(`Failed to fetch keys ${type} from Turso:`, err.message);
            }
          }

          return data;
        },
        set: async (data) => {
          if (isCleanedUp) return;
          for (const category in data) {
            for (const id in data[category]) {
              const value = data[category][id];
              const keyId = `${category}-${id}`;

              if (value) {
                // Update RAM cache immediately (0ms)
                memoryCache.set(keyId, value);
                const serialized = JSON.stringify(value, BufferJSON.replacer);
                pendingKeyWrites.set(keyId, serialized);
              } else {
                memoryCache.delete(keyId);
                pendingKeyWrites.set(keyId, null);
              }
            }
          }
        }
      }
    },
    saveCreds: async () => {
      credsDirty = true;
      if (isCleanedUp) return;
      try {
        const serializedCreds = JSON.stringify(creds, BufferJSON.replacer);
        await client.execute({
          sql: `INSERT INTO wa_auth_sessions (session_id, key_id, value, updated_at)
                VALUES (?, 'creds', ?, CURRENT_TIMESTAMP)
                ON CONFLICT(session_id, key_id) 
                DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP`,
          args: [sessionId, serializedCreds]
        });
        credsDirty = false;
      } catch (err) {
        console.warn('Immediate creds flush warning:', err.message);
      }
    },
    cleanup: () => {
      isCleanedUp = true;
      clearInterval(flushInterval);
      memoryCache.clear();
      pendingKeyWrites.clear();
      credsDirty = false;
    }
  };
}
