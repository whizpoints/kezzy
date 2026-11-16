import makeWASocket, {
  DisconnectReason,
  fetchLatestBaileysVersion,
  Browsers
} from '@whiskeysockets/baileys';
import pino from 'pino';
import QRCode from 'qrcode';
import NodeCache from 'node-cache';
import { useTursoAuthState } from './tursoAuth.js';
import { retryTelegramCall } from './telegram.js';
import {
  getMappingByWaId,
  saveMapping,
  updateGroupStatus,
  saveMessageHistory,
  saveContact,
  getContact,
  getMessageHistoryByWaId,
  searchContacts,
  getAllMappings,
  updateMappingName,
  getContactsWithPhone,
  updateContactLid
} from './db.js';
import { sanitizeTopicName, downloadWaMedia, getProfilePictureBuffer } from './media.js';

let sockInstance = null;
let activeAuthCleanup = null;
let hasAnnouncedConnected = false;
let latestQrString = null;
let latestQrBuffer = null;
let isInitializingWa = false;
let isRelinkingWa = false;
let lastRelinkTime = 0;

let connectionStatus = {
  connected: false,
  userJid: null,
  qrMessageId: null
};

export function getLatestQr() {
  return {
    qrString: latestQrString,
    qrBuffer: latestQrBuffer,
    connected: connectionStatus.connected,
    userJid: connectionStatus.userJid
  };
}

// Caches for retry counter, raw proto messages, and echo suppression
const msgRetryCounterCache = new NodeCache();
export const rawMessageCache = new NodeCache({ stdTTL: 86400, maxKeys: 5000 });
export const botSentMessageIds = new Set();

/**
 * Record message sent from Telegram to prevent echo and allow retry re-encryption
 */
export function recordBotSentMessage(msgId, messageProto) {
  if (!msgId) return;
  botSentMessageIds.add(msgId);
  if (messageProto) {
    rawMessageCache.set(msgId, messageProto);
  }
  if (botSentMessageIds.size > 2000) {
    const first = botSentMessageIds.values().next().value;
    botSentMessageIds.delete(first);
  }
}

function getTopicExtra(topicId, otherExtra = {}) {
  const extra = { ...otherExtra };
  if (topicId && topicId > 1) {
    extra.message_thread_id = topicId;
  }
  return extra;
}

export function getWaSocket() {
  return sockInstance;
}

export function getWaStatus() {
  return connectionStatus;
}

/**
 * Resolve clean, saved display name with phone number for any WhatsApp chat/contact
 */
export async function resolveChatTitle(sock, jid, pushName = null) {
  if (!jid) return 'Unknown Chat';

  if (jid === '__storage_media__') {
    return '📁 Files & Media Storage';
  }

  // 1. WhatsApp Groups
  if (jid.endsWith('@g.us')) {
    try {
      const meta = await sock.groupMetadata(jid);
      if (meta?.subject) {
        return `👥 ${meta.subject}`;
      }
    } catch (_) {}
    return '👥 WhatsApp Group';
  }

  // 2. User's own notes/chat
  const myJid = sock?.user?.id?.split(':')[0]?.split('@')[0];
  const myLid = sock?.user?.lid?.split(':')[0]?.split('@')[0];
  const cleanId = jid.split('@')[0]?.split(':')[0];

  if ((myJid && cleanId === myJid) || (myLid && cleanId === myLid)) {
    return `📝 You (Notes) (+${myJid || ''})`.trim();
  }

  // 3. System / Broadcast
  if (cleanId === '0' || jid === '0@s.whatsapp.net' || cleanId === '+0' || !cleanId) {
    return '📱 WhatsApp System';
  }

  // 4. Look up contact in DB (resolves phone numbers, saved names, and privacy @lid)
  const contact = await getContact(jid);
  if (contact) {
    const rawPhone = contact.phone_number || (!contact.wa_id?.includes('@lid') ? contact.wa_id?.split('@')[0]?.split(':')[0] : '');
    const validPhone = rawPhone && rawPhone.length >= 7 && !rawPhone.includes('@') && rawPhone !== '0' ? ` (+${rawPhone})` : '';

    if (contact.name && contact.name.trim()) {
      return `${contact.name.trim()}${validPhone}`;
    }
    if (pushName && pushName.trim()) {
      return `${pushName.trim()}${validPhone}`;
    }
    if (validPhone) {
      return `Contact${validPhone}`;
    }
  }

  // 5. If it's a standard phone JID
  if (jid.endsWith('@s.whatsapp.net')) {
    const phone = jid.split('@')[0]?.split(':')[0];
    if (phone && phone.length >= 7 && phone !== '0') {
      const namePart = pushName && pushName.trim() ? `${pushName.trim()} ` : '';
      return `${namePart}(+${phone})`.trim();
    }
  }

  // 6. Push name fallback
  if (pushName && pushName.trim()) {
    return pushName.trim();
  }

  // 7. Fallback for unmapped LID
  if (jid.endsWith('@lid')) {
    return `WhatsApp Contact (${cleanId.slice(-4)})`;
  }

  return cleanId && cleanId.length < 12 ? cleanId : 'WhatsApp Contact';
}

/**
 * Synchronize contacts, register own account, and rename all existing forum topics
 * to their clean saved address book names and phone numbers.
 */
export async function syncContactsAndTopics(sock, bot, groupId) {
  if (!sock) {
    throw new Error('WhatsApp socket is not connected');
  }

  console.log('🔄 Auditing forum topic titles and contact mappings...');

  // 1. Register own account LID
  if (sock.user) {
    const myPhone = sock.user.id?.split(':')[0]?.split('@')[0];
    const myLid = sock.user.lid ? `${sock.user.lid.split(':')[0]}@lid` : null;
    if (myPhone) {
      await saveContact({
        waId: `${myPhone}@s.whatsapp.net`,
        name: sock.user.name || 'You',
        phoneNumber: myPhone,
        lid: myLid
      });
      if (myLid) {
        await saveContact({
          waId: myLid,
          name: 'You (Notes)',
          phoneNumber: myPhone,
          lid: myLid
        });
      }
    }
  }

  // 2. Link known active chats where contact is known
  await saveContact({
    waId: '38105386102945@lid',
    name: 'Cucu shanny',
    phoneNumber: '254725415375',
    lid: '38105386102945@lid'
  });

  // 3. Rename existing Telegram Forum Topics that have raw digits, LIDs, or (+0)
  const allMappings = await getAllMappings();
  console.log(`📋 Auditing ${allMappings.length} forum topics for name updates...`);
  let renamedCount = 0;

  for (const mapping of allMappings) {
    if (mapping.wa_id === '__storage_media__') continue;
    const resolvedTitle = await resolveChatTitle(sock, mapping.wa_id);
    const safeTitle = sanitizeTopicName(resolvedTitle);

    const isDigitName = /^\d+$/.test(mapping.chat_name) || mapping.chat_name.includes('(+0)');
    const isLidFallback = mapping.chat_name.startsWith('WhatsApp User');
    const hasBetterName = safeTitle !== mapping.chat_name && (isDigitName || isLidFallback || !mapping.chat_name.includes('(+'));

    if (hasBetterName) {
      try {
        await bot.telegram.editForumTopic(groupId, mapping.tg_topic_id, {
          name: safeTitle
        });
        await updateMappingName(mapping.wa_id, safeTitle);
        renamedCount++;
        console.log(`✨ Renamed topic ${mapping.tg_topic_id} from "${mapping.chat_name}" to "${safeTitle}"`);
        await new Promise(r => setTimeout(r, 500)); // Respect Telegram rate limits
      } catch (err) {
        if (!err.message?.includes('TOPIC_NOT_MODIFIED')) {
          console.warn(`Could not rename topic ${mapping.tg_topic_id}:`, err.message);
        }
      }
    }
  }

  console.log(`✅ Topic synchronization complete: ${renamedCount} topics updated.`);
  return { contactsCount: allMappings.length, renamedCount };
}

/**
 * Automatically fetch and import ALL participating WhatsApp groups into Telegram topics
 */
export async function syncAllGroups(sock, bot, groupId) {
  if (!sock) throw new Error('WhatsApp is not connected');
  console.log('👥 Fetching all participating WhatsApp groups...');

  let groups = {};
  try {
    groups = await sock.groupFetchAllParticipating();
  } catch (err) {
    console.error('Error fetching participating groups:', err.message);
    return { total: 0, created: 0, updated: 0 };
  }

  const groupJids = Object.keys(groups);
  console.log(`Found ${groupJids.length} participating WhatsApp groups.`);

  let createdCount = 0;
  let updatedCount = 0;

  for (const jid of groupJids) {
    const meta = groups[jid];
    const subject = meta?.subject || 'WhatsApp Group';
    const safeTitle = sanitizeTopicName(`👥 ${subject}`);
    const isAnnouncement = !!meta?.announce;
    const myJid = sock.user?.id?.split(':')[0] + '@s.whatsapp.net';
    const part = meta?.participants?.find(p => p.id === myJid);
    const isAdmin = part?.admin === 'admin' || part?.admin === 'superadmin';

    await saveContact({
      waId: jid,
      name: safeTitle
    });

    const existing = await getMappingByWaId(jid);
    if (!existing) {
      try {
        const topic = await bot.telegram.createForumTopic(groupId, safeTitle);
        await saveMapping({
          waId: jid,
          topicId: topic.message_thread_id,
          chatName: safeTitle,
          isGroup: true,
          isAnnouncement,
          isAdmin
        });

        if (isAnnouncement && !isAdmin) {
          await bot.telegram.closeForumTopic(groupId, topic.message_thread_id).catch(() => {});
        }

        const avatarBuffer = await getProfilePictureBuffer(sock, jid);
        if (avatarBuffer) {
          const card = await bot.telegram.sendPhoto(
            groupId,
            { source: avatarBuffer },
            {
              message_thread_id: topic.message_thread_id,
              caption: `📸 <b>${safeTitle}</b>\nGroup ID: <code>${jid}</code>\nMembers: ${meta.participants?.length || 0}`,
              parse_mode: 'HTML'
            }
          ).catch(() => null);

          if (card) {
            await bot.telegram.pinChatMessage(groupId, card.message_id, {
              disable_notification: true
            }).catch(() => {});
          }
        }

        createdCount++;
        console.log(`✨ Imported group topic: "${safeTitle}"`);
        await new Promise(r => setTimeout(r, 600)); // Respect Telegram rate limits
      } catch (err) {
        console.error(`Failed to create topic for group ${subject}:`, err.message);
      }
    } else {
      if (existing.chat_name !== safeTitle) {
        try {
          await bot.telegram.editForumTopic(groupId, existing.tg_topic_id, { name: safeTitle });
          await updateMappingName(jid, safeTitle);
          updatedCount++;
        } catch (_) {}
      }
    }
  }

  console.log(`✅ Groups sync complete: ${createdCount} created, ${updatedCount} updated.`);
  return { total: groupJids.length, created: createdCount, updated: updatedCount };
}

let storageTopicId = null;

/**
 * Get or create dedicated Storage topic in Telegram for all files and media
 */
export async function getOrCreateStorageTopic(bot, groupId) {
  if (storageTopicId) return storageTopicId;

  const existing = await getMappingByWaId('__storage_media__');
  if (existing) {
    storageTopicId = existing.tg_topic_id;
    return storageTopicId;
  }

  try {
    const topic = await bot.telegram.createForumTopic(groupId, '📁 Files & Media Storage');
    storageTopicId = topic.message_thread_id;

    await saveMapping({
      waId: '__storage_media__',
      topicId: storageTopicId,
      chatName: '📁 Files & Media Storage',
      isGroup: false
    });

    const card = await bot.telegram.sendMessage(
      groupId,
      `📁 <b>Files & Media Storage Vault</b>\n\n` +
      `All photos, documents (PDF, Word, etc.), voice notes, and videos from all your WhatsApp groups and private chats are automatically backed up here for quick browsing without scrolling through conversations.`,
      {
        message_thread_id: storageTopicId,
        parse_mode: 'HTML'
      }
    );

    await bot.telegram.pinChatMessage(groupId, card.message_id, {
      disable_notification: true
    }).catch(() => {});

    console.log(`✨ Created dedicated Storage topic (ID: ${storageTopicId})`);
    return storageTopicId;
  } catch (err) {
    console.error('Failed to create Storage topic:', err.message);
    return null;
  }
}

/**
 * Mirror media file to the dedicated Storage Vault topic with rate limit backoff retry
 */
export async function mirrorMediaToStorage(bot, groupId, { mediaType, buffer, filename, caption = '', chatTitle, senderName, timeStr }, maxRetries = 2) {
  try {
    const sTopicId = await getOrCreateStorageTopic(bot, groupId);
    if (!sTopicId) return;

    let storageCaption = `📁 <b>${escapeHtml(chatTitle || 'WhatsApp')}</b>\n`;
    if (senderName) {
      storageCaption += `👤 <b>From:</b> ${escapeHtml(senderName)}\n`;
    }
    if (timeStr) {
      storageCaption += `🕒 <i>${timeStr}</i>\n`;
    }
    if (caption) {
      storageCaption += `\n💬 ${escapeHtml(caption)}`;
    }
    storageCaption = storageCaption.trim();

    const extra = {
      message_thread_id: sTopicId,
      caption: storageCaption,
      parse_mode: 'HTML'
    };

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        if (mediaType === 'image') {
          await bot.telegram.sendPhoto(groupId, { source: buffer }, extra);
        } else if (mediaType === 'document') {
          await bot.telegram.sendDocument(groupId, { source: buffer, filename: filename || 'file' }, extra);
        } else if (mediaType === 'voice') {
          await bot.telegram.sendVoice(groupId, { source: buffer }, extra);
        } else if (mediaType === 'audio') {
          await bot.telegram.sendAudio(groupId, { source: buffer, filename: filename || 'audio.mp3' }, extra);
        } else if (mediaType === 'video') {
          await bot.telegram.sendVideo(groupId, { source: buffer }, extra);
        }
        break;
      } catch (sendErr) {
        if (sendErr.parameters?.retry_after && attempt < maxRetries) {
          const waitSec = sendErr.parameters.retry_after + 1;
          await new Promise(r => setTimeout(r, waitSec * 1000));
          continue;
        }
        throw sendErr;
      }
    }
  } catch (err) {
    console.warn('Storage vault mirror note:', err.message);
  }
}

export async function initWhatsApp({
  client,
  sessionId = 'main_wa_session',
  bot,
  groupId,
  generalTopicId = 1
}) {
  if (isInitializingWa) {
    console.log('⚠️ WhatsApp initialization is already in progress, skipping duplicate call.');
    return sockInstance;
  }
  isInitializingWa = true;

  try {
    // Ensure previous socket is cleanly terminated before creating a new one
    if (sockInstance) {
      console.log('Cleaning up existing socket instance before re-initializing...');
      try {
        sockInstance.ev.removeAllListeners();
        sockInstance.end();
      } catch (_) {}
      sockInstance = null;
    }

    if (activeAuthCleanup) {
      try {
        activeAuthCleanup();
      } catch (_) {}
      activeAuthCleanup = null;
    }

    const { state, saveCreds, cleanup } = await useTursoAuthState(client, sessionId);
    activeAuthCleanup = cleanup;

    let version = [2, 3000, 1043857760];
    try {
      const versionPromise = fetchLatestBaileysVersion();
      const timeoutPromise = new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 4000));
      const res = await Promise.race([versionPromise, timeoutPromise]);
      if (res?.version) version = res.version;
    } catch (_) {
      console.log('⚡ Using stable fallback Baileys version');
    }

    const sock = makeWASocket({
      version,
      auth: state,
      logger: pino({ level: 'silent' }),
      browser: Browsers.macOS('Desktop'),
      msgRetryCounterCache,
      getMessage: async (key) => {
        const cached = rawMessageCache.get(key.id);
        if (cached) return cached;
        return undefined;
      },
      syncFullHistory: false,
      shouldSyncHistoryMessage: () => true,
      defaultQueryTimeoutMs: 60000
    });

    sockInstance = sock;

    // Listen for creds updates
    sock.ev.on('creds.update', saveCreds);

    // Connection events (QR, Connected, Disconnected)
    sock.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect, qr } = update;

      // Handle QR code generation for linking
      if (qr) {
        console.log('⚡ New WhatsApp QR Code generated');
        latestQrString = qr;

        try {
          const qrBuffer = await QRCode.toBuffer(qr, { width: 400, margin: 2 });
          latestQrBuffer = qrBuffer;

          // Render ASCII QR in terminal / console for instant scan
          try {
            const terminalQr = await QRCode.toString(qr, { type: 'terminal', small: true });
            console.log('\n' + terminalQr);
            console.log('📱 Scan the QR code above or view at /qr to link WhatsApp.\n');
          } catch (_) {}

          const captionText = '📱 <b>Link WhatsApp:</b>\nScan this QR code in <b>WhatsApp > Linked Devices</b> to start the bridge with full history sync.';

          // If we already sent a QR photo, edit it in-place using editMessageMedia to avoid socket hang ups & spam
          if (connectionStatus.qrMessageId) {
            try {
              await retryTelegramCall(async () => {
                await bot.telegram.editMessageMedia(
                  groupId,
                  connectionStatus.qrMessageId,
                  undefined,
                  {
                    type: 'photo',
                    media: { source: qrBuffer, filename: 'qr.png' },
                    caption: captionText,
                    parse_mode: 'HTML'
                  }
                );
              }, 3, 1000);
              return;
            } catch (editErr) {
              console.warn('Could not edit existing QR message, sending a fresh one:', editErr.message);
              try {
                await bot.telegram.deleteMessage(groupId, connectionStatus.qrMessageId).catch(() => {});
              } catch (_) {}
              connectionStatus.qrMessageId = null;
            }
          }

          // Send fresh photo with retry
          const sent = await retryTelegramCall(async () => {
            return await bot.telegram.sendPhoto(
              groupId,
              { source: qrBuffer, filename: 'qr.png' },
              getTopicExtra(generalTopicId, {
                caption: captionText,
                parse_mode: 'HTML'
              })
            );
          }, 3, 1000);

          if (sent?.message_id) {
            connectionStatus.qrMessageId = sent.message_id;
          }
        } catch (err) {
          console.error('Failed to send QR to Telegram after retries:', err.message);
        }
      }

      if (connection === 'open') {
        connectionStatus.connected = true;
        connectionStatus.userJid = sock.user.id;
        latestQrString = null;
        latestQrBuffer = null;
        console.log('✅ WhatsApp connection opened successfully as:', sock.user.id);

        if (connectionStatus.qrMessageId) {
          try {
            await bot.telegram.deleteMessage(groupId, connectionStatus.qrMessageId);
            connectionStatus.qrMessageId = null;
          } catch (_) {}
        }

let lastAnnounceTime = 0;

      // Only announce once every 10 minutes to prevent flooding Telegram chat on reboots/reconnects
      const now = Date.now();
      if (!hasAnnouncedConnected && now - lastAnnounceTime > 600000) {
        hasAnnouncedConnected = true;
        lastAnnounceTime = now;
        await bot.telegram.sendMessage(
          groupId,
          `🟢 <b>WhatsApp Bridge Online:</b> Logged in as <code>${sock.user.id.split(':')[0]}</code>. Ready to route messages.`,
          getTopicExtra(generalTopicId, {
            parse_mode: 'HTML'
          })
        ).catch(() => {});
      }

      // Trigger automatic background contact LID resolution, topic renaming, and all groups sync
      setTimeout(async () => {
        try {
          await syncContactsAndTopics(sock, bot, groupId);
          await syncAllGroups(sock, bot, groupId);
        } catch (err) {
          console.warn('Initial background sync error:', err.message);
        }
      }, 4000);
    }

    if (connection === 'close') {
      connectionStatus.connected = false;
      const statusCode = lastDisconnect?.error?.output?.statusCode;
      const isReplaced = statusCode === DisconnectReason.connectionReplaced;
      const isLoggedOut = statusCode === DisconnectReason.loggedOut;

      console.log(`🔴 WhatsApp disconnected. Reason code: ${statusCode}. Replaced: ${isReplaced}. LoggedOut: ${isLoggedOut}`);

      // If connection was replaced by a newer session, do NOT reconnect in loop
      if (isReplaced) {
        console.log('⚠️ Connection replaced by another session. Halting old socket.');
        return;
      }

      if (isLoggedOut) {
        console.log('🔴 WhatsApp session logged out / expired. Generating fresh QR code...');
        hasAnnouncedConnected = false;
        try {
          await client.execute({
            sql: 'DELETE FROM wa_auth_sessions WHERE session_id = ?',
            args: [sessionId]
          });
        } catch (_) {}

        await bot.telegram.sendMessage(
          groupId,
          '⚠️ <b>WhatsApp Logged Out:</b> Generating a fresh QR code with <b>Full History Sync enabled</b>...',
          getTopicExtra(generalTopicId, {
            parse_mode: 'HTML'
          })
        ).catch(() => {});

        setTimeout(() => {
          initWhatsApp({ client, sessionId, bot, groupId, generalTopicId });
        }, 3000);
        return;
      }

      // Standard network reconnect
      setTimeout(() => {
        console.log('🔄 Attempting WhatsApp reconnection...');
        initWhatsApp({ client, sessionId, bot, groupId, generalTopicId });
      }, 5000);
    }
  });

  // ================= 1. SYNC CONTACTS & PHONE NUMBER SHARES ================= //
  sock.ev.on('contacts.upsert', async (contacts) => {
    for (const c of contacts) {
      if (!c.id) continue;
      const savedName = c.name || c.verifiedName || null;
      const pushName = c.notify || null;
      const bestName = savedName || pushName;

      let phone = null;
      let lid = null;

      if (c.id.endsWith('@s.whatsapp.net')) {
        phone = c.id.split('@')[0]?.split(':')[0];
      } else if (c.id.endsWith('@lid')) {
        lid = c.id;
      }

      if (c.lid) lid = c.lid;
      if (c.phoneNumber) phone = c.phoneNumber;

      await saveContact({
        waId: c.id,
        name: bestName,
        phoneNumber: phone,
        lid
      });
    }
  });

  // Listen for WhatsApp phone number sharing for LIDs
  sock.ev.on('chats.phoneNumberShare', async ({ lid, jid }) => {
    if (!lid || !jid) return;
    console.log(`📱 Received phone number share: LID ${lid} -> JID ${jid}`);
    const phone = jid.split('@')[0]?.split(':')[0];
    const existing = await getContact(jid);
    const name = existing?.name || null;

    await saveContact({
      waId: jid,
      name,
      phoneNumber: phone,
      lid
    });

    // Check if topic exists for this LID and rename it
    const mapping = await getMappingByWaId(lid);
    if (mapping) {
      const newTitle = await resolveChatTitle(sock, lid);
      const safeTitle = sanitizeTopicName(newTitle);
      if (safeTitle !== mapping.chat_name) {
        try {
          await bot.telegram.editForumTopic(groupId, mapping.tg_topic_id, { name: safeTitle });
          await updateMappingName(lid, safeTitle);
          console.log(`✨ Automatically renamed topic ${mapping.tg_topic_id} to "${safeTitle}" on phone number share.`);
        } catch (_) {}
      }
    }
  });

  // ================= 2. PROCESS CHATS & UPDATE TOPIC NAMES ================= //
  sock.ev.on('chats.upsert', async (chats) => {
    console.log(`📥 Received chats.upsert with ${chats.length} chats`);
    for (const chat of chats) {
      const waId = chat.id;
      if (!waId || waId === 'status@broadcast' || waId.includes('@newsletter')) continue;

      const pnJid = chat.pnJid;
      const lidJid = chat.lidJid || (chat.id.endsWith('@lid') ? chat.id : null);
      const phone = pnJid ? pnJid.split('@')[0]?.split(':')[0] : (chat.id.endsWith('@s.whatsapp.net') ? chat.id.split('@')[0]?.split(':')[0] : null);
      const name = chat.name || chat.displayName || null;

      if (phone || lidJid || name) {
        await saveContact({
          waId: chat.id,
          name,
          phoneNumber: phone,
          lid: lidJid
        });
        if (lidJid && (phone || name)) {
          await saveContact({
            waId: lidJid,
            name,
            phoneNumber: phone,
            lid: lidJid
          });
        }
      }

      // Upgrade existing topic name if it currently has raw digits or (+0)
      const existing = await getMappingByWaId(waId);
      if (existing) {
        if (/^\d+$/.test(existing.chat_name) || existing.chat_name.includes('(+0)') || existing.chat_name.startsWith('WhatsApp')) {
          const newTitle = await resolveChatTitle(sock, waId, chat.name || chat.displayName);
          const safeTitle = sanitizeTopicName(newTitle);
          if (safeTitle !== existing.chat_name && !/^\d+$/.test(safeTitle)) {
            try {
              await bot.telegram.editForumTopic(groupId, existing.tg_topic_id, { name: safeTitle });
              await updateMappingName(waId, safeTitle);
              console.log(`✨ Upgraded existing topic ${existing.tg_topic_id} name from "${existing.chat_name}" to "${safeTitle}"`);
            } catch (_) {}
          }
        }
      }
    }
  });

  // ================= 3. HISTORICAL MESSAGES CATCHUP WITH REAL MEDIA ================= //
  sock.ev.on('messaging-history.set', async ({ chats, contacts, messages, isLatest }) => {
    try {
      console.log(`📥 Received history sync package: ${chats?.length || 0} chats, ${contacts?.length || 0} contacts, ${messages?.length || 0} messages`);

      // 1. Process chats metadata
      if (chats && chats.length > 0) {
        for (const chat of chats) {
          if (!chat.id) continue;
          const pnJid = chat.pnJid;
          const lidJid = chat.lidJid || (chat.id.endsWith('@lid') ? chat.id : null);
          const phone = pnJid ? pnJid.split('@')[0]?.split(':')[0] : (chat.id.endsWith('@s.whatsapp.net') ? chat.id.split('@')[0]?.split(':')[0] : null);
          const name = chat.name || chat.displayName || null;

          if (phone || lidJid || name) {
            try {
              await saveContact({
                waId: chat.id,
                name,
                phoneNumber: phone,
                lid: lidJid
              });
              if (lidJid && pnJid) {
                await saveContact({
                  waId: lidJid,
                  name,
                  phoneNumber: phone,
                  lid: lidJid
                });
              }
            } catch (_) {}
          }
        }
      }

      // 2. Process contacts address book
      if (contacts && contacts.length > 0) {
        for (const c of contacts) {
          if (!c.id) continue;
          const savedName = c.name || c.verifiedName || null;
          const pushName = c.notify || null;
          const bestName = savedName || pushName;
          const phone = c.id.endsWith('@s.whatsapp.net') ? c.id.split('@')[0]?.split(':')[0] : (c.phoneNumber || null);
          const lid = c.lid || (c.id.endsWith('@lid') ? c.id : null);

          try {
            await saveContact({
              waId: c.id,
              name: bestName,
              phoneNumber: phone,
              lid
            });
          } catch (_) {}
        }
      }

    if (!messages || messages.length === 0) return;

    // Helper for sending history with rate limit retry
    const sendWithRetry = async (fn, maxRetries = 3) => {
      for (let attempt = 0; attempt <= maxRetries; attempt++) {
        try {
          return await fn();
        } catch (err) {
          if (err.parameters?.retry_after && attempt < maxRetries) {
            const waitSec = err.parameters.retry_after + 1;
            console.log(`⏳ Telegram rate limit. Pausing ${waitSec}s before retrying...`);
            await new Promise(r => setTimeout(r, waitSec * 1000));
            continue;
          }
          throw err;
        }
      }
    };

    // 31 days cutoff timestamp
    const THIRTY_ONE_DAYS_SEC = 31 * 24 * 60 * 60;
    const cutoffTimestampSec = Math.floor(Date.now() / 1000) - THIRTY_ONE_DAYS_SEC;

    // Group messages by chat (filter to past 31 days)
    const messagesByChat = new Map();
    for (const m of messages) {
      if (!m.message) continue;
      const remoteJid = m.key.remoteJid;
      if (!remoteJid || remoteJid === 'status@broadcast' || remoteJid.includes('@newsletter')) continue;

      const ts = Number(m.messageTimestamp || 0);
      if (ts > 0 && ts < cutoffTimestampSec) {
        continue; // Skip messages older than 31 days
      }

      if (!messagesByChat.has(remoteJid)) {
        messagesByChat.set(remoteJid, []);
      }
      messagesByChat.get(remoteJid).push(m);
    }

    // Sort all chats with 31-day activity by most recent message timestamp
    const activeChats = Array.from(messagesByChat.keys()).sort((a, b) => {
      const msgsA = messagesByChat.get(a) || [];
      const msgsB = messagesByChat.get(b) || [];
      const lastA = msgsA[msgsA.length - 1]?.messageTimestamp || 0;
      const lastB = msgsB[msgsB.length - 1]?.messageTimestamp || 0;
      return Number(lastB) - Number(lastA);
    });

    console.log(`⏳ Backfilling ${activeChats.length} active chats & groups (past 31 days) into Telegram topics with full attachments...`);

    for (const chatJid of activeChats) {
      const isGroup = chatJid.endsWith('@g.us');
      let mapping = await getMappingByWaId(chatJid);

      if (!mapping) {
        // Extract best display name from incoming messages in this chat
        const msgs = messagesByChat.get(chatJid) || [];
        const incomingWithPush = msgs.find(m => !m.key.fromMe && m.pushName);
        const bestPushName = incomingWithPush?.pushName || null;

        if (bestPushName) {
          try {
            await saveContact({
              waId: chatJid,
              name: bestPushName,
              lid: chatJid.endsWith('@lid') ? chatJid : null
            });
          } catch (_) {}
        }

        const resolvedTitle = await resolveChatTitle(sock, chatJid, bestPushName);
        const safeTitle = sanitizeTopicName(resolvedTitle);

        try {
          const topic = await bot.telegram.createForumTopic(groupId, safeTitle);
          mapping = await saveMapping({
            waId: chatJid,
            topicId: topic.message_thread_id,
            chatName: safeTitle,
            isGroup
          });

          // Fetch & pin profile photo card
          const avatarBuffer = await getProfilePictureBuffer(sock, chatJid);
          if (avatarBuffer) {
            const card = await bot.telegram.sendPhoto(
              groupId,
              { source: avatarBuffer },
              {
                message_thread_id: topic.message_thread_id,
                caption: `📸 <b>${safeTitle}</b>`,
                parse_mode: 'HTML'
              }
            ).catch(() => null);

            if (card) {
              await bot.telegram.pinChatMessage(groupId, card.message_id, {
                disable_notification: true
              }).catch(() => {});
            }
          }

          await new Promise(r => setTimeout(r, 600));
        } catch (err) {
          console.error(`Failed to create topic for history chat ${chatJid}:`, err.message);
          continue;
        }
      }

      const topicId = mapping.tg_topic_id;
      const chatMsgs = messagesByChat.get(chatJid) || [];
      chatMsgs.sort((a, b) => Number(a.messageTimestamp || 0) - Number(b.messageTimestamp || 0));
      // Process up to 100 recent messages in the 31-day window
      const recentSlice = chatMsgs.slice(-100);

      for (const m of recentSlice) {
        const alreadySaved = await getMessageHistoryByWaId(m.key.id);
        const hasMedia = !!(m.message.imageMessage || m.message.documentMessage || m.message.audioMessage || m.message.videoMessage);

        // If already saved with actual binary media, skip. If saved previously with placeholder text, allow media backfill!
        if (alreadySaved && (!hasMedia || alreadySaved.media_type !== 'text')) {
          continue;
        }

        const isFromMe = !!m.key.fromMe;
        const senderJid = isGroup ? m.key.participant : chatJid;
        const senderName = m.pushName || (senderJid ? senderJid.split('@')[0] : 'Unknown');

        let timeStr = '';
        if (m.messageTimestamp) {
          const d = new Date(Number(m.messageTimestamp) * 1000);
          timeStr = d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) + ' ' +
                    d.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
        }

        let prefix = `🕒 <i>[Past - ${timeStr}]</i>\n`;
        if (isFromMe) {
          prefix += '📤 <b>[You (WhatsApp Phone)]:</b>\n';
        } else if (isGroup) {
          prefix += `<b>[${senderName}]:</b>\n`;
        }

        const msgContent = m.message;
        let sentTgMsg = null;
        let mediaType = 'text';
        let bodyText = '';

        try {
          // --- 1. Plain Text ---
          if (msgContent.conversation || msgContent.extendedTextMessage) {
            bodyText = msgContent.conversation || msgContent.extendedTextMessage?.text || '';
            const formatted = isFromMe
              ? `${prefix}<blockquote>${escapeHtml(bodyText)}</blockquote>`
              : `${prefix}${escapeHtml(bodyText)}`;

            sentTgMsg = await sendWithRetry(() =>
              bot.telegram.sendMessage(groupId, formatted, {
                message_thread_id: topicId,
                parse_mode: 'HTML'
              })
            );
          }
          // --- 2. Image ---
          else if (msgContent.imageMessage) {
            mediaType = 'image';
            bodyText = msgContent.imageMessage.caption || '';
            const caption = `${prefix}${escapeHtml(bodyText)}`.trim();
            const buffer = await downloadWaMedia(m);
            if (buffer) {
              sentTgMsg = await sendWithRetry(() =>
                bot.telegram.sendPhoto(groupId, { source: buffer }, {
                  message_thread_id: topicId,
                  caption,
                  parse_mode: 'HTML'
                })
              );

              // Mirror photo to dedicated Storage Vault
              await mirrorMediaToStorage(bot, groupId, {
                mediaType: 'image',
                buffer,
                caption: bodyText,
                chatTitle: mapping.chat_name,
                senderName: isFromMe ? 'You' : senderName,
                timeStr
              }).catch(() => {});
              await new Promise(r => setTimeout(r, 400));
            } else {
              sentTgMsg = await sendWithRetry(() =>
                bot.telegram.sendMessage(
                  groupId,
                  `${prefix}📷 <i>[Photo - WhatsApp media expired]</i>\n${escapeHtml(bodyText)}`.trim(),
                  { message_thread_id: topicId, parse_mode: 'HTML' }
                )
              );
            }
          }
          // --- 3. Document / PDF / File ---
          else if (msgContent.documentMessage) {
            mediaType = 'document';
            const doc = msgContent.documentMessage;
            bodyText = doc.caption || '';
            const fileName = doc.fileName || 'document';
            const caption = `${prefix}${escapeHtml(bodyText)}`.trim();
            const buffer = await downloadWaMedia(m);
            if (buffer) {
              sentTgMsg = await sendWithRetry(() =>
                bot.telegram.sendDocument(groupId, { source: buffer, filename: fileName }, {
                  message_thread_id: topicId,
                  caption,
                  parse_mode: 'HTML'
                })
              );

              // Mirror document to dedicated Storage Vault
              await mirrorMediaToStorage(bot, groupId, {
                mediaType: 'document',
                buffer,
                filename: fileName,
                caption: bodyText,
                chatTitle: mapping.chat_name,
                senderName: isFromMe ? 'You' : senderName,
                timeStr
              }).catch(() => {});
              await new Promise(r => setTimeout(r, 400));
            } else {
              sentTgMsg = await sendWithRetry(() =>
                bot.telegram.sendMessage(
                  groupId,
                  `${prefix}📄 <i>[Document: ${escapeHtml(fileName)} - WhatsApp media expired]</i>\n${escapeHtml(bodyText)}`.trim(),
                  { message_thread_id: topicId, parse_mode: 'HTML' }
                )
              );
            }
          }
          // --- 4. Audio / Voice ---
          else if (msgContent.audioMessage) {
            const isVoice = !!msgContent.audioMessage.ptt;
            mediaType = isVoice ? 'voice' : 'audio';
            const buffer = await downloadWaMedia(m);
            if (buffer) {
              if (isVoice) {
                sentTgMsg = await sendWithRetry(() =>
                  bot.telegram.sendVoice(groupId, { source: buffer }, {
                    message_thread_id: topicId,
                    caption: prefix.trim(),
                    parse_mode: 'HTML'
                  })
                );
              } else {
                sentTgMsg = await sendWithRetry(() =>
                  bot.telegram.sendAudio(groupId, { source: buffer, filename: 'audio.mp3' }, {
                    message_thread_id: topicId,
                    caption: prefix.trim(),
                    parse_mode: 'HTML'
                  })
                );
              }

              // Mirror audio to dedicated Storage Vault
              await mirrorMediaToStorage(bot, groupId, {
                mediaType: isVoice ? 'voice' : 'audio',
                buffer,
                filename: 'audio.mp3',
                caption: '',
                chatTitle: mapping.chat_name,
                senderName: isFromMe ? 'You' : senderName,
                timeStr
              }).catch(() => {});
              await new Promise(r => setTimeout(r, 400));
            } else {
              sentTgMsg = await sendWithRetry(() =>
                bot.telegram.sendMessage(
                  groupId,
                  `${prefix}🎤 <i>[Voice Note - WhatsApp media expired]</i>`,
                  { message_thread_id: topicId, parse_mode: 'HTML' }
                )
              );
            }
          }
          // --- 5. Video ---
          else if (msgContent.videoMessage) {
            mediaType = 'video';
            bodyText = msgContent.videoMessage.caption || '';
            const caption = `${prefix}${escapeHtml(bodyText)}`.trim();
            const buffer = await downloadWaMedia(m);
            if (buffer) {
              sentTgMsg = await sendWithRetry(() =>
                bot.telegram.sendVideo(groupId, { source: buffer }, {
                  message_thread_id: topicId,
                  caption,
                  parse_mode: 'HTML'
                })
              );

              // Mirror video to dedicated Storage Vault
              await mirrorMediaToStorage(bot, groupId, {
                mediaType: 'video',
                buffer,
                caption: bodyText,
                chatTitle: mapping.chat_name,
                senderName: isFromMe ? 'You' : senderName,
                timeStr
              }).catch(() => {});
              await new Promise(r => setTimeout(r, 400));
            } else {
              sentTgMsg = await sendWithRetry(() =>
                bot.telegram.sendMessage(
                  groupId,
                  `${prefix}🎥 <i>[Video - WhatsApp media expired]</i>\n${escapeHtml(bodyText)}`.trim(),
                  { message_thread_id: topicId, parse_mode: 'HTML' }
                )
              );
            }
          }

          if (sentTgMsg) {
            await saveMessageHistory({
              waMessageId: m.key.id,
              tgMessageId: sentTgMsg.message_id,
              waChatId: chatJid,
              tgTopicId: topicId,
              senderWaId: isFromMe ? 'me' : senderJid,
              contentText: bodyText,
              mediaType
            });
          }

          await new Promise(r => setTimeout(r, 500)); // Respect Telegram supergroup rate limit
        } catch (err) {
          console.error('Error forwarding history message:', err.message);
        }
      }
    }

    console.log('✅ History backfill complete!');
    } catch (syncErr) {
      console.error('History sync handler error:', syncErr.message);
    }
  });

  // ================= 4. INCOMING & PHONE-OUTGOING MESSAGES ================= //
  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return;

    for (const m of messages) {
      if (!m.message) continue;

      const isFromMe = !!m.key.fromMe;
      const remoteJid = m.key.remoteJid;
      if (!remoteJid) continue;
      if (remoteJid === 'status@broadcast' || remoteJid.includes('@newsletter')) continue;

      // Cache raw message for retry decryption
      rawMessageCache.set(m.key.id, m.message);

      // If sent by Telegram bot, skip echo
      if (isFromMe && botSentMessageIds.has(m.key.id)) {
        botSentMessageIds.delete(m.key.id);
        continue;
      }

      const isGroup = remoteJid.endsWith('@g.us');
      const senderJid = isGroup ? m.key.participant : remoteJid;
      const senderName = m.pushName || (senderJid ? senderJid.split('@')[0] : 'Unknown');

      // 1. Find or create Forum Topic
      let mapping = await getMappingByWaId(remoteJid);
      if (!mapping) {
        const resolvedTitle = await resolveChatTitle(sock, remoteJid, m.pushName);
        const safeTitle = sanitizeTopicName(resolvedTitle);
        let isAnnouncement = false;
        let isAdmin = false;

        if (isGroup) {
          try {
            const meta = await sock.groupMetadata(remoteJid);
            isAnnouncement = !!meta.announce;
            const myJid = sock.user.id.split(':')[0] + '@s.whatsapp.net';
            const part = meta.participants.find(p => p.id === myJid);
            isAdmin = part?.admin === 'admin' || part?.admin === 'superadmin';
          } catch (_) {}
        }

        try {
          const topic = await bot.telegram.createForumTopic(groupId, safeTitle);
          mapping = await saveMapping({
            waId: remoteJid,
            topicId: topic.message_thread_id,
            chatName: safeTitle,
            isGroup,
            isAnnouncement,
            isAdmin
          });

          if (isAnnouncement && !isAdmin) {
            await bot.telegram.closeForumTopic(groupId, mapping.tg_topic_id).catch(() => {});
          }

          // Fetch & pin profile photo card
          const avatarBuffer = await getProfilePictureBuffer(sock, remoteJid);
          if (avatarBuffer) {
            const card = await bot.telegram.sendPhoto(
              groupId,
              { source: avatarBuffer },
              {
                message_thread_id: topic.message_thread_id,
                caption: `📸 <b>${safeTitle}</b>\nWhatsApp: <code>${remoteJid.split('@')[0]}</code>`,
                parse_mode: 'HTML'
              }
            ).catch(() => null);

            if (card) {
              await bot.telegram.pinChatMessage(groupId, card.message_id, {
                disable_notification: true
              }).catch(() => {});
            }
          }

          console.log(`✨ Created new Telegram Topic "${safeTitle}" for ${remoteJid}`);
        } catch (err) {
          console.error('Failed to auto-create topic for incoming chat:', err);
          continue;
        }
      } else {
        // Upgrade topic name if it's currently digits
        if (/^\d+$/.test(mapping.chat_name) || mapping.chat_name.includes('(+0)')) {
          const resolved = await resolveChatTitle(sock, remoteJid, senderName);
          const safe = sanitizeTopicName(resolved);
          if (safe !== mapping.chat_name && !/^\d+$/.test(safe)) {
            try {
              await bot.telegram.editForumTopic(groupId, mapping.tg_topic_id, { name: safe });
              await updateMappingName(remoteJid, safe);
              mapping.chat_name = safe;
              console.log(`✨ Dynamically upgraded topic ${mapping.tg_topic_id} name to "${safe}"`);
            } catch (_) {}
          }
        }
      }

      const topicId = mapping.tg_topic_id;

      let prefix = '';
      if (isFromMe) {
        prefix = '📤 <b>[You (WhatsApp Phone)]:</b>\n';
      } else if (isGroup) {
        prefix = `<b>[${senderName}]:</b>\n`;
      }

      try {
        let sentTgMsg = null;
        let mediaType = 'text';
        let bodyText = '';

        const msgContent = m.message;

        // Self-healing topic recovery wrapper
        const sendWithTopicRecovery = async (sendFn) => {
          try {
            return await sendFn(topicId);
          } catch (err) {
            if (err.description?.includes('message thread not found') || err.message?.includes('message thread not found')) {
              console.log(`⚠️ Topic ${topicId} for ${remoteJid} was deleted in Telegram. Recreating topic...`);
              const resolvedTitle = await resolveChatTitle(sock, remoteJid, senderName);
              const safeTitle = sanitizeTopicName(resolvedTitle);
              const newTopic = await bot.telegram.createForumTopic(groupId, safeTitle);
              const newTopicId = newTopic.message_thread_id;

              try {
                await saveMapping({
                  waId: remoteJid,
                  topicId: newTopicId,
                  chatName: safeTitle,
                  isGroup: mapping.is_group,
                  isAnnouncement: mapping.is_announcement,
                  isAdmin: mapping.is_admin
                });
              } catch (dbErr) {
                console.warn('Warning: Failed to update mapping in Turso during recovery:', dbErr.message);
              }

              if (mapping.is_announcement && !mapping.is_admin) {
                await bot.telegram.closeForumTopic(groupId, newTopicId).catch(() => {});
              }

              const avatarBuffer = await getProfilePictureBuffer(sock, remoteJid);
              if (avatarBuffer) {
                const card = await bot.telegram.sendPhoto(
                  groupId,
                  { source: avatarBuffer },
                  {
                    message_thread_id: newTopicId,
                    caption: `📸 <b>${safeTitle}</b>\nWhatsApp: <code>${remoteJid.split('@')[0]}</code>`,
                    parse_mode: 'HTML'
                  }
                ).catch(() => null);

                if (card) {
                  await bot.telegram.pinChatMessage(groupId, card.message_id, {
                    disable_notification: true
                  }).catch(() => {});
                }
              }

              return await sendFn(newTopicId);
            }
            throw err;
          }
        };

        // --- 1. Plain Text Message ---
        if (msgContent.conversation || msgContent.extendedTextMessage) {
          bodyText = msgContent.conversation || msgContent.extendedTextMessage.text || '';
          const formatted = isFromMe
            ? `${prefix}<blockquote>${escapeHtml(bodyText)}</blockquote>`
            : `${prefix}${escapeHtml(bodyText)}`;

          sentTgMsg = await sendWithTopicRecovery((tid) =>
            bot.telegram.sendMessage(
              groupId,
              formatted,
              {
                message_thread_id: tid,
                parse_mode: 'HTML'
              }
            )
          );
        }
        // --- 2. Image Message ---
        else if (msgContent.imageMessage) {
          mediaType = 'image';
          bodyText = msgContent.imageMessage.caption || '';
          const buffer = await downloadWaMedia(m);
          if (buffer) {
            sentTgMsg = await sendWithTopicRecovery((tid) =>
              bot.telegram.sendPhoto(
                groupId,
                { source: buffer },
                {
                  message_thread_id: tid,
                  caption: `${prefix}${escapeHtml(bodyText)}`,
                  parse_mode: 'HTML'
                }
              )
            );
            await mirrorMediaToStorage(bot, groupId, {
              mediaType: 'image',
              buffer,
              caption: bodyText,
              chatTitle: mapping.chat_name,
              senderName: isFromMe ? 'You' : senderName,
              timeStr: new Date().toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' })
            }).catch(() => {});
          }
        }
        // --- 3. Document / PDF / File ---
        else if (msgContent.documentMessage) {
          mediaType = 'document';
          const doc = msgContent.documentMessage;
          bodyText = doc.caption || '';
          const fileName = doc.fileName || 'document';
          const buffer = await downloadWaMedia(m);
          if (buffer) {
            sentTgMsg = await sendWithTopicRecovery((tid) =>
              bot.telegram.sendDocument(
                groupId,
                { source: buffer, filename: fileName },
                {
                  message_thread_id: tid,
                  caption: `${prefix}${escapeHtml(bodyText)}`,
                  parse_mode: 'HTML'
                }
              )
            );
            await mirrorMediaToStorage(bot, groupId, {
              mediaType: 'document',
              buffer,
              filename: fileName,
              caption: bodyText,
              chatTitle: mapping.chat_name,
              senderName: isFromMe ? 'You' : senderName,
              timeStr: new Date().toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' })
            }).catch(() => {});
          }
        }
        // --- 4. Audio / Voice Note ---
        else if (msgContent.audioMessage) {
          const isVoice = !!msgContent.audioMessage.ptt;
          mediaType = isVoice ? 'voice' : 'audio';
          const buffer = await downloadWaMedia(m);
          if (buffer) {
            if (isVoice) {
              sentTgMsg = await sendWithTopicRecovery((tid) =>
                bot.telegram.sendVoice(
                  groupId,
                  { source: buffer },
                  {
                    message_thread_id: tid,
                    caption: prefix ? prefix.trim() : undefined,
                    parse_mode: 'HTML'
                  }
                )
              );
            } else {
              sentTgMsg = await sendWithTopicRecovery((tid) =>
                bot.telegram.sendAudio(
                  groupId,
                  { source: buffer, filename: 'audio.mp3' },
                  {
                    message_thread_id: tid,
                    caption: prefix ? prefix.trim() : undefined,
                    parse_mode: 'HTML'
                  }
                )
              );
            }
            await mirrorMediaToStorage(bot, groupId, {
              mediaType: isVoice ? 'voice' : 'audio',
              buffer,
              filename: 'audio.mp3',
              caption: '',
              chatTitle: mapping.chat_name,
              senderName: isFromMe ? 'You' : senderName,
              timeStr: new Date().toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' })
            }).catch(() => {});
          }
        }
        // --- 5. Video Message ---
        else if (msgContent.videoMessage) {
          mediaType = 'video';
          bodyText = msgContent.videoMessage.caption || '';
          const buffer = await downloadWaMedia(m);
          if (buffer) {
            sentTgMsg = await sendWithTopicRecovery((tid) =>
              bot.telegram.sendVideo(
                groupId,
                { source: buffer },
                {
                  message_thread_id: tid,
                  caption: `${prefix}${escapeHtml(bodyText)}`,
                  parse_mode: 'HTML'
                }
              )
            );
            await mirrorMediaToStorage(bot, groupId, {
              mediaType: 'video',
              buffer,
              caption: bodyText,
              chatTitle: mapping.chat_name,
              senderName: isFromMe ? 'You' : senderName,
              timeStr: new Date().toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' })
            }).catch(() => {});
          }
        }
        // --- 6. Sticker Message ---
        else if (msgContent.stickerMessage) {
          mediaType = 'sticker';
          const buffer = await downloadWaMedia(m);
          if (buffer) {
            sentTgMsg = await sendWithTopicRecovery((tid) =>
              bot.telegram.sendDocument(
                groupId,
                { source: buffer, filename: 'sticker.webp' },
                {
                  message_thread_id: tid,
                  caption: `${prefix}<i>[Sticker]</i>`,
                  parse_mode: 'HTML'
                }
              )
            );
          }
        }

        if (sentTgMsg) {
          await saveMessageHistory({
            waMessageId: m.key.id,
            tgMessageId: sentTgMsg.message_id,
            waChatId: remoteJid,
            tgTopicId: topicId,
            senderWaId: isFromMe ? 'me' : senderJid,
            contentText: bodyText,
            mediaType
          });
        }
      } catch (err) {
        console.error(`Error forwarding WhatsApp message from ${remoteJid}:`, err);
      }
    }
  });

  // Cooldown map to avoid spamming the same caller with auto-replies
  const callReplyCooldown = new Map();

  // ================= 5. WHATSAPP CALL NOTIFICATIONS & AUTO-DECLINE ================= //
  sock.ev.on('call', async (calls) => {
    for (const call of calls) {
      const callerJid = call.from;
      if (!callerJid) continue;

      const isVideo = !!call.isVideo;
      const callTypeStr = isVideo ? 'Video Call' : 'Voice Call';

      // Find or create topic for caller
      let mapping = await getMappingByWaId(callerJid);
      let topicId = mapping?.tg_topic_id;

      if (!topicId) {
        const resolvedTitle = await resolveChatTitle(sock, callerJid);
        const safeTitle = sanitizeTopicName(resolvedTitle);
        try {
          const topic = await bot.telegram.createForumTopic(groupId, safeTitle);
          topicId = topic.message_thread_id;
          mapping = await saveMapping({
            waId: callerJid,
            topicId,
            chatName: safeTitle,
            isGroup: !!call.isGroup
          });
        } catch (_) {}
      }

      if (!topicId) topicId = generalTopicId;

      const callerTitle = mapping?.chat_name || (await resolveChatTitle(sock, callerJid));
      const nowStr = new Date().toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });

      // Handle call statuses: offer (incoming ringing -> auto-decline & auto-reply), timeout (missed)
      if (call.status === 'offer') {
        console.log(`📞 Incoming ${callTypeStr} from ${callerJid} (Auto-Declined)`);

        // 1. Auto-reject call on WhatsApp
        try {
          await sock.rejectCall(call.id, call.from);
        } catch (rejErr) {
          console.warn('Could not auto-reject call:', rejErr.message);
        }

        // 2. Send automated polite WhatsApp reply (throttled to once every 5 minutes per contact)
        const lastAutoReply = callReplyCooldown.get(callerJid) || 0;
        let sentAutoReply = false;
        if (Date.now() - lastAutoReply > 5 * 60 * 1000) {
          callReplyCooldown.set(callerJid, Date.now());

          let targetWaJid = callerJid;
          if (targetWaJid.endsWith('@lid')) {
            const contact = await getContact(targetWaJid);
            if (contact?.phone_number) {
              targetWaJid = `${contact.phone_number}@s.whatsapp.net`;
            }
          }

          try {
            await sock.sendMessage(targetWaJid, {
              text: 'Hello! I am currently unable to take voice or video calls. Please leave a voice note or send a text message here, and I will reply shortly.'
            });
            sentAutoReply = true;
            console.log(`✉️ Sent automated WhatsApp decline notice to ${targetWaJid}`);
          } catch (replyErr) {
            console.warn('Failed to send call auto-reply on WhatsApp:', replyErr.message);
          }
        }

        // 3. Post notification in Telegram Topic
        const replyNote = sentAutoReply
          ? `\n💬 <i>Auto-replied on WhatsApp asking them to send a voice note or text message.</i>`
          : '';

        await bot.telegram.sendMessage(
          groupId,
          `🔔 <b>Incoming WhatsApp ${callTypeStr} (Auto-Declined)</b>\n` +
          `👤 <b>From:</b> ${escapeHtml(callerTitle)}\n` +
          `🕒 <i>${nowStr}</i>\n\n` +
          `ℹ️ <i>Telegram cannot bridge live VoIP calls. Call was auto-declined.</i>${replyNote}`,
          {
            message_thread_id: topicId,
            parse_mode: 'HTML'
          }
        ).catch(() => {});
      } else if (call.status === 'timeout') {
        console.log(`📵 Missed ${callTypeStr} from ${callerJid}`);
        await bot.telegram.sendMessage(
          groupId,
          `📵 <b>Missed WhatsApp ${callTypeStr}</b>\n` +
          `👤 <b>From:</b> ${escapeHtml(callerTitle)}\n` +
          `🕒 <i>${nowStr}</i>`,
          {
            message_thread_id: topicId,
            parse_mode: 'HTML'
          }
        ).catch(() => {});
      }
    }
  });

  return sock;
  } finally {
    isInitializingWa = false;
  }
}

function escapeHtml(text) {
  if (!text) return '';
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

export async function relinkWhatsApp({ client, sessionId = 'main_wa_session', bot, groupId, generalTopicId = 1 }) {
  const now = Date.now();
  if (isRelinkingWa || (now - lastRelinkTime < 10000)) {
    console.log('⚠️ Relink is already in progress or recently executed, skipping duplicate.');
    return;
  }
  isRelinkingWa = true;
  lastRelinkTime = now;

  console.log('🔄 Resetting WhatsApp session for clean relink & pairing...');
  hasAnnouncedConnected = false;
  connectionStatus.connected = false;
  connectionStatus.userJid = null;
  latestQrString = null;
  latestQrBuffer = null;

  if (activeAuthCleanup) {
    try {
      activeAuthCleanup();
    } catch (_) {}
    activeAuthCleanup = null;
  }

  if (sockInstance) {
    try {
      sockInstance.ev.removeAllListeners();
      sockInstance.end();
    } catch (_) {}
    sockInstance = null;
  }

  try {
    await client.execute({
      sql: 'DELETE FROM wa_auth_sessions WHERE session_id = ?',
      args: [sessionId]
    });
    await client.execute('DELETE FROM message_history');
  } catch (err) {
    console.warn('Error clearing Turso tables on relink:', err.message);
  }

  try {
    await retryTelegramCall(async () => {
      await bot.telegram.sendMessage(
        groupId,
        '🔄 <b>Generating New WhatsApp QR Code:</b>\nPlease wait a moment for the new pairing QR code to appear below.\nOnce it appears, scan in <b>WhatsApp > Linked Devices</b>.',
        getTopicExtra(generalTopicId, { parse_mode: 'HTML' })
      );
    }, 2, 800);
  } catch (err) {
    console.warn('Could not send relink status notice to Telegram:', err.message);
  }

  setTimeout(() => {
    isRelinkingWa = false;
    initWhatsApp({ client, sessionId, bot, groupId, generalTopicId });
  }, 1000);
}
