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
  updateContactLid,
  seedContactsFromFile
} from './db.js';
import { sanitizeTopicName, downloadWaMedia, getProfilePictureBuffer, unwrapWaMessage, parseVCard } from './media.js';

let sockInstance = null;
let activeAuthCleanup = null;
let hasAnnouncedConnected = false;
let latestQrString = null;
let latestQrBuffer = null;
let isInitializingWa = false;
let isRelinkingWa = false;
let lastRelinkTime = 0;
let lastAnnounceTime = 0;
let reconnectTimer = null;
let reconnectAttempts = 0;

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
 * Shared helper to extract and persist contact metadata from Baileys events
 */
export async function processContactData(c) {
  if (!c || !c.id) return null;
  const savedName = c.name || c.verifiedName || null;
  const pushName = c.notify || null;
  const bestName = savedName || pushName || null;

  let phone = null;
  let lid = null;

  // Extract phone number from id or jid
  if (c.id.endsWith('@s.whatsapp.net')) {
    phone = c.id.split('@')[0].split(':')[0];
  } else if (c.jid && c.jid.endsWith('@s.whatsapp.net')) {
    phone = c.jid.split('@')[0].split(':')[0];
  }

  // Extract LID from id or lid
  if (c.id.endsWith('@lid')) {
    lid = c.id.split(':')[0] + '@lid';
  } else if (c.lid && c.lid.endsWith('@lid')) {
    lid = c.lid.split(':')[0] + '@lid';
  }

  if (c.phoneNumber) {
    phone = String(c.phoneNumber).replace(/[^\d]/g, '');
  }

  await saveContact({
    waId: c.id,
    name: bestName,
    phoneNumber: phone,
    lid
  });

  return { waId: c.id, name: bestName, phone, lid };
}

/**
 * Resolve display name for message sender in groups and private chats
 * Priority 1: User's saved address book name
 * Priority 2: Public WhatsApp push name (+ phone)
 * Priority 3: Phone number (+254...)
 * Priority 4: Clean fallback
 */
export async function resolveSenderDisplayName(senderJid, pushName = null) {
  if (!senderJid) return pushName || 'Unknown';

  const contact = await getContact(senderJid);
  const savedName = contact?.name && contact.name.trim();
  const rawPhone = contact?.phone_number || (senderJid.endsWith('@s.whatsapp.net') ? senderJid.split('@')[0].split(':')[0] : null);
  const validPhone = rawPhone && rawPhone.length >= 7 && rawPhone !== '0' ? ` (+${rawPhone})` : '';

  // 1. Saved Address Book Contact Name (Highest Priority)
  if (savedName) {
    return `${savedName}${validPhone}`;
  }

  // 2. WhatsApp Public Push Name
  if (pushName && pushName.trim()) {
    return `${pushName.trim()}${validPhone}`;
  }

  // 3. Known Phone Number
  if (validPhone) {
    return `+${rawPhone}`;
  }

  // 4. Fallback for unmapped LID
  const cleanId = senderJid.split('@')[0].split(':')[0];
  if (senderJid.endsWith('@lid')) {
    return `WhatsApp User (${cleanId.slice(-4)})`;
  }

  return cleanId || 'Unknown';
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
  const dbName = contact?.name && contact.name.trim();
  const dbPhone = contact?.phone_number || (!contact?.wa_id?.includes('@lid') ? contact?.wa_id?.split('@')[0]?.split(':')[0] : null);
  const validPhone = dbPhone && dbPhone.length >= 7 && !dbPhone.includes('@') && dbPhone !== '0' ? ` (+${dbPhone})` : '';

  if (dbName && !dbName.startsWith('WhatsApp Contact') && !dbName.startsWith('WhatsApp User') && !/^\d+$/.test(dbName)) {
    return `${dbName}${validPhone}`;
  }

  // 5. If pushName is provided, persist it and use it
  if (pushName && pushName.trim() && !pushName.startsWith('WhatsApp Contact') && !pushName.startsWith('WhatsApp User')) {
    const cleanPush = pushName.trim();
    try {
      await saveContact({
        waId: jid,
        name: cleanPush,
        phoneNumber: dbPhone,
        lid: jid.endsWith('@lid') ? jid : (contact?.lid || null)
      });
    } catch (_) {}
    return `${cleanPush}${validPhone}`;
  }

  // 6. Query WhatsApp Real APIs for unmapped user (Business profile, status / bio)
  if (sock && jid) {
    // 6a. WhatsApp Business Profile (name, verified title, or category)
    try {
      const biz = await sock.getBusinessProfile(jid);
      if (biz?.name && biz.name.trim()) {
        const bName = biz.name.trim();
        await saveContact({ waId: jid, name: bName, phoneNumber: dbPhone, lid: jid.endsWith('@lid') ? jid : null }).catch(() => {});
        return `${bName}${validPhone}`;
      }
      if (biz?.description && biz.description.trim() && biz.description.length < 35) {
        return `${biz.description.trim()}${validPhone}`;
      }
    } catch (_) {}

    // 6b. WhatsApp Status / Bio (About)
    try {
      const stList = await sock.fetchStatus(jid);
      const stItem = stList?.[0]?.status;
      const stText = typeof stItem === 'string' ? stItem : stItem?.status;
      if (stText && stText.trim() && stText.length > 2 && stText.length < 35 && !stText.startsWith('http')) {
        return `${stText.trim()}${validPhone}`;
      }
    } catch (_) {}
  }

  // 7. If standard phone JID, show clean formatted phone number
  if (jid.endsWith('@s.whatsapp.net')) {
    const phone = jid.split('@')[0]?.split(':')[0];
    if (phone && phone.length >= 7 && phone !== '0') {
      return `+${phone}`;
    }
  }

  // 8. If contact has a known phone number in DB
  if (dbPhone && dbPhone.length >= 7 && dbPhone !== '0') {
    return `+${dbPhone}`;
  }

  // 9. Fallback for unmapped LID
  if (jid.endsWith('@lid')) {
    return `WhatsApp User (${cleanId.slice(-4)})`;
  }

  return cleanId && cleanId.length < 15 ? `+${cleanId}` : 'WhatsApp Contact';
}

/**
 * Force WhatsApp Baileys to download the full address book and contact mutations
 */
export async function resyncContactsAndAppState(sock) {
  if (!sock) return;
  console.log('🔄 Triggering full App State sync for contacts & address book...');
  const collections = ['critical_unblock_low', 'critical_block', 'regular_high', 'regular_low', 'regular'];
  try {
    await sock.resyncAppState(collections, true);
    console.log('✅ App State Sync request dispatched successfully.');
  } catch (err) {
    console.warn('App state sync notice:', err.message);
  }
}

/**
 * Generate and pin profile picture card at the top of a topic
 */
export async function ensurePinnedProfileCard(sock, bot, groupId, topicId, waId, chatName) {
  if (!bot || !groupId || !topicId || !waId) return;
  if (waId === '__storage_media__' || waId === '0@s.whatsapp.net') return;

  try {
    if (waId.endsWith('@g.us')) {
      const buffer = await getProfilePictureBuffer(sock, waId, chatName);
      if (buffer) {
        const caption =
          `👥 <b>${escapeHtml(chatName)}</b>\n` +
          `💬 <b>WhatsApp Group</b>\n\n` +
          `📌 <i>Pinned Group Info</i>`;

        const card = await retryTelegramCall(() =>
          bot.telegram.sendPhoto(
            groupId,
            { source: buffer, filename: 'group.jpg' },
            {
              message_thread_id: topicId,
              caption,
              parse_mode: 'HTML'
            }
          ), 2, 800
        ).catch(() => null);

        if (card) {
          await bot.telegram.pinChatMessage(groupId, card.message_id, {
            disable_notification: true
          }).catch(() => {});
        }
      }
      return;
    }

    const contact = await getContact(waId);
    const name = contact?.name || chatName.replace(/\s*\(\+.*\)/, '') || 'WhatsApp Contact';
    const phone = contact?.phone_number || (waId.includes('@s.whatsapp.net') ? waId.split('@')[0] : null);

    const buffer = await getProfilePictureBuffer(sock, waId, name, phone);
    if (!buffer) return;

    const caption =
      `👤 <b>${escapeHtml(name)}</b>\n` +
      `📞 <code>+${phone || 'Unsaved'}</code>\n` +
      `💬 <b>WhatsApp Direct Chat</b>\n\n` +
      `📌 <i>Pinned Profile Card</i>`;

    const card = await retryTelegramCall(() =>
      bot.telegram.sendPhoto(
        groupId,
        { source: buffer, filename: 'profile.jpg' },
        {
          message_thread_id: topicId,
          caption,
          parse_mode: 'HTML'
        }
      ), 2, 800
    ).catch(() => null);

    if (card) {
      await bot.telegram.pinChatMessage(groupId, card.message_id, {
        disable_notification: true
      }).catch(() => {});
    }
  } catch (err) {
    // Ignore rate limits or temporary pin errors gracefully
  }
}

/**
 * Generate Telegram inline reply buttons for forwarded WhatsApp messages
 */
export function makeReplyMarkup(msgKey, isFromMe, mediaType = 'text', groupId = null, storageTopicId = null) {
  if (isFromMe || !msgKey?.id) return undefined;
  const buttons = [
    { text: '💬 Reply', callback_data: `wa_reply:${msgKey.id}` }
  ];
  if (mediaType !== 'text' && storageTopicId && groupId) {
    const cleanGid = String(groupId).replace('-100', '');
    buttons.push({ text: '📁 Storage', url: `https://t.me/c/${cleanGid}/${storageTopicId}` });
  }
  return { inline_keyboard: [buttons] };
}

/**
 * Automatically check and upgrade Telegram topic name if a better contact name was discovered
 */
export async function renameTopicIfBetter(sock, bot, groupId, c) {
  if (!c || !c.id || !bot) return;

  const targetWaId = c.id;
  const candidateLid = c.lid || (targetWaId.endsWith('@lid') ? targetWaId : null);
  const candidatePhone = c.phoneNumber || (targetWaId.endsWith('@s.whatsapp.net') ? targetWaId.split('@')[0].split(':')[0] : null);

  let mapping = await getMappingByWaId(targetWaId);
  if (!mapping && candidateLid) {
    mapping = await getMappingByWaId(candidateLid);
  }
  if (!mapping && candidatePhone) {
    mapping = await getMappingByWaId(`${candidatePhone}@s.whatsapp.net`);
  }

  if (!mapping) return;

  const isGeneric =
    mapping.chat_name.startsWith('WhatsApp Contact') ||
    mapping.chat_name.startsWith('WhatsApp User') ||
    /^\d+$/.test(mapping.chat_name) ||
    mapping.chat_name.includes('(+0)');

  const resolved = await resolveChatTitle(sock, mapping.wa_id, c.name);
  const safe = sanitizeTopicName(resolved);

  if (safe !== mapping.chat_name && (isGeneric || (!mapping.chat_name.includes('(+') && safe.includes('(+')))) {
    try {
      await retryTelegramCall(async () => {
        await bot.telegram.editForumTopic(groupId, mapping.tg_topic_id, { name: safe });
      }, 2, 800);
      await updateMappingName(mapping.wa_id, safe);
      console.log(`✨ Renamed topic ${mapping.tg_topic_id} from "${mapping.chat_name}" to "${safe}" on contact update.`);
    } catch (err) {
      if (!err.message?.includes('TOPIC_NOT_MODIFIED')) {
        console.warn(`Could not rename topic ${mapping.tg_topic_id}:`, err.message);
      }
    }
  }
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

  // Pre-create and ensure Storage Vault Topic exists on startup
  await getOrCreateStorageTopic(bot, groupId);

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

  // 2. Trigger app state resync to pull address book
  await resyncContactsAndAppState(sock);

  // 3. Batch resolve WhatsApp LIDs for all contacts with phone numbers
  try {
    const contactsWithPhone = await getContactsWithPhone();
    if (contactsWithPhone.length > 0) {
      console.log(`📱 Resolving LIDs for ${contactsWithPhone.length} phone contacts via onWhatsApp...`);
      const chunkSize = 25;
      for (let i = 0; i < contactsWithPhone.length; i += chunkSize) {
        const chunk = contactsWithPhone.slice(i, i + chunkSize);
        const phones = chunk.map(c => c.phone_number);
        try {
          const results = await sock.onWhatsApp(...phones);
          if (Array.isArray(results)) {
            for (const res of results) {
              if (res.exists && res.lid) {
                const phone = res.jid.split('@')[0]?.split(':')[0];
                const matching = chunk.find(c => c.phone_number === phone);
                const contactName = matching?.name || null;
                await updateContactLid(phone, res.lid);
                await saveContact({
                  waId: res.lid,
                  name: contactName,
                  phoneNumber: phone,
                  lid: res.lid
                });
              }
            }
          }
        } catch (onWaErr) {
          console.warn('onWhatsApp batch query note:', onWaErr.message);
        }
        await new Promise(r => setTimeout(r, 400));
      }
    }
  } catch (err) {
    console.warn('LID resolution note:', err.message);
  }

  // 4. Audit existing Telegram Forum Topics
  const allMappings = await getAllMappings();
  console.log(`📋 Auditing ${allMappings.length} forum topics for name updates...`);
  let renamedCount = 0;

  for (const mapping of allMappings) {
    if (mapping.wa_id === '__storage_media__') continue;
    const resolvedTitle = await resolveChatTitle(sock, mapping.wa_id);
    const safeTitle = sanitizeTopicName(resolvedTitle);

    const isGeneric =
      mapping.chat_name.startsWith('WhatsApp Contact') ||
      mapping.chat_name.startsWith('WhatsApp User') ||
      /^\d+$/.test(mapping.chat_name) ||
      mapping.chat_name.includes('(+0)');

    const hasBetterName = safeTitle !== mapping.chat_name && (isGeneric || (!mapping.chat_name.includes('(+') && safeTitle.includes('(+')));

    if (hasBetterName) {
      try {
        await retryTelegramCall(async () => {
          await bot.telegram.editForumTopic(groupId, mapping.tg_topic_id, {
            name: safeTitle
          });
        }, 2, 800);
        await updateMappingName(mapping.wa_id, safeTitle);
        renamedCount++;
        console.log(`✨ Renamed topic ${mapping.tg_topic_id} from "${mapping.chat_name}" to "${safeTitle}"`);
        await new Promise(r => setTimeout(r, 600)); // Respect Telegram rate limits
      } catch (err) {
        if (!err.message?.includes('TOPIC_NOT_MODIFIED')) {
          console.warn(`Could not rename topic ${mapping.tg_topic_id}:`, err.message);
        }
      }
    }

    // Ensure 1:1 chat topics have their pinned profile photo cards
    if (!mapping.is_group && mapping.wa_id !== '__storage_media__' && mapping.wa_id !== '0@s.whatsapp.net') {
      await ensurePinnedProfileCard(sock, bot, groupId, mapping.tg_topic_id, mapping.wa_id, safeTitle);
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
  // Clear any pending reconnect timer
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }

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
        sockInstance._isClosing = true;
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
      browser: Browsers.ubuntu('Chrome'),
      msgRetryCounterCache,
      getMessage: async (key) => {
        const cached = rawMessageCache.get(key.id);
        if (cached) return cached;
        return undefined;
      },
      syncFullHistory: true,
      shouldSyncHistoryMessage: () => true,
      defaultQueryTimeoutMs: 60000
    });

    sockInstance = sock;

    // Listen for creds updates
    sock.ev.on('creds.update', async (update) => {
      saveCreds(update);
      if (update?.myAppStateKeyId) {
        console.log('🔑 New app state sync key received, triggering background address book sync...');
        setTimeout(() => {
          resyncContactsAndAppState(sock).catch(() => {});
        }, 1500);
      }
    });

    // Connection events (QR, Connected, Disconnected)
    sock.ev.on('connection.update', async (update) => {
      // If this socket was intentionally closed, ignore events from it
      if (sock._isClosing) return;

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
            console.log('📱 Scan the QR code above or view at https://kezzy.onrender.com/qr to link WhatsApp.\n');
          } catch (_) {}

          const captionText = '📱 <b>Link WhatsApp:</b>\nScan this QR code in <b>WhatsApp > Linked Devices</b> to start the bridge.\n\n🌐 <b>Live Web View:</b> https://kezzy.onrender.com/qr';

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
              }, 2, 800);
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
          }, 2, 800);

          if (sent?.message_id) {
            connectionStatus.qrMessageId = sent.message_id;
          }
        } catch (err) {
          console.error('Failed to send QR to Telegram after retries:', err.message);
        }
      }

      if (connection === 'open') {
        reconnectAttempts = 0;
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

        // Resync Baileys app state to pull full address book and group names
        setTimeout(async () => {
          try {
            await resyncContactsAndAppState(sock);
          } catch (syncErr) {
            console.warn('App state resync warning:', syncErr.message);
          }
        }, 2000);

        // Pre-create and ensure Storage Vault Topic exists on startup
        await getOrCreateStorageTopic(bot, groupId);

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
        latestQrString = null;
        latestQrBuffer = null;
        const statusCode = lastDisconnect?.error?.output?.statusCode;
        const isReplaced = statusCode === DisconnectReason.connectionReplaced;
        const isLoggedOut = statusCode === DisconnectReason.loggedOut;

        console.log(`🔴 WhatsApp disconnected. Reason code: ${statusCode}. Replaced: ${isReplaced}. LoggedOut: ${isLoggedOut}`);

        if (sock._isClosing) {
          return;
        }

        // If connection was replaced by a newer session, do NOT reconnect in loop
        if (isReplaced) {
          console.log('⚠️ Connection replaced by another session. Halting old socket.');
          return;
        }

        if (reconnectTimer) {
          clearTimeout(reconnectTimer);
          reconnectTimer = null;
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
            '⚠️ <b>WhatsApp Logged Out:</b> Generating a fresh QR code...',
            getTopicExtra(generalTopicId, {
              parse_mode: 'HTML'
            })
          ).catch(() => {});

          reconnectTimer = setTimeout(() => {
            reconnectTimer = null;
            initWhatsApp({ client, sessionId, bot, groupId, generalTopicId });
          }, 3000);
          return;
        }

        // Standard network reconnect with exponential backoff
        reconnectAttempts++;
        const delay = Math.min(3000 * Math.pow(1.5, reconnectAttempts - 1), 15000);
        console.log(`🔄 Attempting WhatsApp reconnection in ${Math.round(delay / 1000)}s (attempt ${reconnectAttempts})...`);
        reconnectTimer = setTimeout(() => {
          reconnectTimer = null;
          initWhatsApp({ client, sessionId, bot, groupId, generalTopicId });
        }, delay);
      }
    });

  // ================= 1. SYNC CONTACTS & PHONE NUMBER SHARES ================= //
  sock.ev.on('contacts.upsert', async (contacts) => {
    for (const c of contacts) {
      await processContactData(c);
      await renameTopicIfBetter(sock, bot, groupId, c);
    }
  });

  sock.ev.on('contacts.update', async (updates) => {
    for (const c of updates) {
      await processContactData(c);
      await renameTopicIfBetter(sock, bot, groupId, c);
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

      await processContactData({
        id: chat.id,
        jid: chat.pnJid || chat.id,
        lid: chat.lidJid || (chat.id.endsWith('@lid') ? chat.id : null),
        name: chat.name || chat.displayName || null
      });

      // Upgrade existing topic name if it currently has raw digits, (+0), or generic fallback
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

  sock.ev.on('chats.update', async (chats) => {
    for (const chat of chats) {
      if (!chat.id) continue;
      await processContactData({
        id: chat.id,
        jid: chat.pnJid || chat.id,
        lid: chat.lidJid || (chat.id.endsWith('@lid') ? chat.id : null),
        name: chat.name || chat.displayName || null
      });
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
          await processContactData({
            id: chat.id,
            jid: chat.pnJid || chat.id,
            lid: chat.lidJid || (chat.id.endsWith('@lid') ? chat.id : null),
            name: chat.name || chat.displayName || null
          });
        }
      }

      // 2. Process contacts address book
      if (contacts && contacts.length > 0) {
        for (const c of contacts) {
          await processContactData(c);
        }
      }

    if (!messages || messages.length === 0) return;

    // Helper for sending history with full network error & rate limit retry
    const sendWithRetry = async (fn, maxRetries = 3) => {
      return await retryTelegramCall(fn, maxRetries, 1000);
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
          await ensurePinnedProfileCard(sock, bot, groupId, topic.message_thread_id, chatJid, safeTitle);

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
        const unwrapped = unwrapWaMessage(m.message);
        if (!unwrapped || Object.keys(unwrapped).length === 0) continue;

        const alreadySaved = await getMessageHistoryByWaId(m.key.id);
        const hasMedia = !!(unwrapped.imageMessage || unwrapped.documentMessage || unwrapped.audioMessage || unwrapped.videoMessage || unwrapped.contactMessage || unwrapped.contactsArrayMessage);

        // If already saved with actual binary media, skip. If saved previously with placeholder text, allow media backfill!
        if (alreadySaved && (!hasMedia || alreadySaved.media_type !== 'text')) {
          continue;
        }

        const isFromMe = !!m.key.fromMe;
        const senderJid = isGroup ? (m.key.participant || m.participant) : chatJid;
        const senderName = await resolveSenderDisplayName(senderJid, m.pushName);

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

        const msgContent = unwrapped;
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

            const replyMarkup = makeReplyMarkup(m.key, isFromMe, 'text', groupId, storageTopicId);
            sentTgMsg = await sendWithRetry(() =>
              bot.telegram.sendMessage(groupId, formatted, {
                message_thread_id: topicId,
                parse_mode: 'HTML',
                reply_markup: replyMarkup
              })
            );
          }
          // --- 2. Image ---
          else if (msgContent.imageMessage) {
            mediaType = 'image';
            bodyText = msgContent.imageMessage.caption || '';
            const caption = `${prefix}${escapeHtml(bodyText)}`.trim();
            const buffer = await downloadWaMedia(m, sock);
            const replyMarkup = makeReplyMarkup(m.key, isFromMe, 'image', groupId, storageTopicId);
            if (buffer) {
              sentTgMsg = await sendWithRetry(() =>
                bot.telegram.sendPhoto(groupId, { source: buffer, filename: 'photo.jpg' }, {
                  message_thread_id: topicId,
                  caption,
                  parse_mode: 'HTML',
                  reply_markup: replyMarkup
                })
              );

              // Mirror photo to dedicated Storage Vault
              await mirrorMediaToStorage(bot, groupId, {
                mediaType: 'image',
                buffer,
                filename: 'photo.jpg',
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
                  { message_thread_id: topicId, parse_mode: 'HTML', reply_markup: replyMarkup }
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
            const buffer = await downloadWaMedia(m, sock);
            const replyMarkup = makeReplyMarkup(m.key, isFromMe, 'document', groupId, storageTopicId);
            if (buffer) {
              sentTgMsg = await sendWithRetry(() =>
                bot.telegram.sendDocument(groupId, { source: buffer, filename: fileName }, {
                  message_thread_id: topicId,
                  caption,
                  parse_mode: 'HTML',
                  reply_markup: replyMarkup
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
                  { message_thread_id: topicId, parse_mode: 'HTML', reply_markup: replyMarkup }
                )
              );
            }
          }
          // --- 4. Audio / Voice ---
          else if (msgContent.audioMessage) {
            const isVoice = !!msgContent.audioMessage.ptt;
            mediaType = isVoice ? 'voice' : 'audio';
            const buffer = await downloadWaMedia(m, sock);
            const replyMarkup = makeReplyMarkup(m.key, isFromMe, mediaType, groupId, storageTopicId);
            if (buffer) {
              if (isVoice) {
                sentTgMsg = await sendWithRetry(() =>
                  bot.telegram.sendVoice(groupId, { source: buffer }, {
                    message_thread_id: topicId,
                    caption: prefix.trim(),
                    parse_mode: 'HTML',
                    reply_markup: replyMarkup
                  })
                );
              } else {
                sentTgMsg = await sendWithRetry(() =>
                  bot.telegram.sendAudio(groupId, { source: buffer, filename: 'audio.mp3' }, {
                    message_thread_id: topicId,
                    caption: prefix.trim(),
                    parse_mode: 'HTML',
                    reply_markup: replyMarkup
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
                  { message_thread_id: topicId, parse_mode: 'HTML', reply_markup: replyMarkup }
                )
              );
            }
          }
          // --- 5. Video ---
          else if (msgContent.videoMessage) {
            mediaType = 'video';
            bodyText = msgContent.videoMessage.caption || '';
            const caption = `${prefix}${escapeHtml(bodyText)}`.trim();
            const buffer = await downloadWaMedia(m, sock);
            const replyMarkup = makeReplyMarkup(m.key, isFromMe, 'video', groupId, storageTopicId);
            if (buffer) {
              sentTgMsg = await sendWithRetry(() =>
                bot.telegram.sendVideo(groupId, { source: buffer, filename: 'video.mp4' }, {
                  message_thread_id: topicId,
                  caption,
                  parse_mode: 'HTML',
                  reply_markup: replyMarkup
                })
              );

              // Mirror video to dedicated Storage Vault
              await mirrorMediaToStorage(bot, groupId, {
                mediaType: 'video',
                buffer,
                filename: 'video.mp4',
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
                  { message_thread_id: topicId, parse_mode: 'HTML', reply_markup: replyMarkup }
                )
              );
            }
          }
          // --- 6. Contact Card ---
          else if (msgContent.contactMessage || msgContent.contactsArrayMessage) {
            mediaType = 'contact';
            const contactsList = msgContent.contactsArrayMessage?.contacts || (msgContent.contactMessage ? [msgContent.contactMessage] : []);
            for (const card of contactsList) {
              const parsed = parseVCard(card.vcard, card.displayName);
              if (parsed.phone) {
                await saveContact({
                  waId: `${parsed.phone}@s.whatsapp.net`,
                  name: parsed.name,
                  phoneNumber: parsed.phone
                });
              }

              let topicLink = '';
              if (parsed.phone) {
                const contactMapping = await getMappingByWaId(`${parsed.phone}@s.whatsapp.net`);
                if (contactMapping) {
                  const cleanGroupId = String(groupId).replace(/^-100/, '');
                  topicLink = `\n👉 <a href="https://t.me/c/${cleanGroupId}/${contactMapping.tg_topic_id}">Open WhatsApp Topic</a>`;
                }
              }

              const formatted = `${prefix}👤 <b>Contact Shared:</b>\n` +
                `• <b>Name:</b> ${escapeHtml(parsed.name)}\n` +
                `• <b>Phone:</b> <code>+${escapeHtml(parsed.phone || 'N/A')}</code>` +
                topicLink;

              sentTgMsg = await sendWithRetry(() =>
                bot.telegram.sendMessage(groupId, formatted, {
                  message_thread_id: topicId,
                  parse_mode: 'HTML'
                })
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
    if (type !== 'notify' && type !== 'append') return;

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

      const unwrapped = unwrapWaMessage(m.message);
      if (!unwrapped || Object.keys(unwrapped).length === 0) continue;

      const isGroup = remoteJid.endsWith('@g.us');
      const senderJid = isGroup ? (m.key.participant || m.participant) : remoteJid;

      // Only cache pushName if the sender does not already have a saved address book name
      if (m.pushName && m.pushName.trim()) {
        const cleanPush = m.pushName.trim();
        const existing = await getContact(senderJid);
        const hasSavedName = existing?.name && !existing.name.startsWith('WhatsApp') && !existing.name.startsWith('Contact ') && !existing.name.startsWith('+') && !/^\d+$/.test(existing.name);
        if (!hasSavedName) {
          await saveContact({
            waId: senderJid,
            name: cleanPush,
            lid: senderJid.endsWith('@lid') ? senderJid : null
          }).catch(() => {});
          if (remoteJid !== senderJid) {
            await saveContact({
              waId: remoteJid,
              name: cleanPush,
              lid: remoteJid.endsWith('@lid') ? remoteJid : null
            }).catch(() => {});
          }
        }
      }

      const senderName = await resolveSenderDisplayName(senderJid, m.pushName);

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
          const topic = await retryTelegramCall(() => bot.telegram.createForumTopic(groupId, safeTitle), 3, 1000);
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
          await ensurePinnedProfileCard(sock, bot, groupId, topic.message_thread_id, remoteJid, safeTitle);

          console.log(`✨ Created new Telegram Topic "${safeTitle}" for ${remoteJid}`);
        } catch (err) {
          console.error('Failed to auto-create topic for incoming chat:', err);
          continue;
        }
      } else {
        // Upgrade topic name ONLY if it's currently generic (e.g. WhatsApp Contact, WhatsApp User, or raw digits)
        const currentTitle = mapping.chat_name || '';
        const isGeneric =
          currentTitle.startsWith('WhatsApp Contact') ||
          currentTitle.startsWith('WhatsApp User') ||
          currentTitle.startsWith('Contact ') ||
          currentTitle.includes('(+0)') ||
          /^\d+$/.test(currentTitle);

        if (isGeneric) {
          const resolved = await resolveChatTitle(sock, remoteJid, m.pushName || senderName);
          const safe = sanitizeTopicName(resolved);
          if (safe !== currentTitle && !/^\d+$/.test(safe) && !safe.startsWith('WhatsApp Contact') && !safe.startsWith('WhatsApp User')) {
            try {
              await retryTelegramCall(() => bot.telegram.editForumTopic(groupId, mapping.tg_topic_id, { name: safe }), 3, 1000);
              await updateMappingName(remoteJid, safe);
              mapping.chat_name = safe;
              console.log(`✨ Dynamically upgraded topic ${mapping.tg_topic_id} name from "${currentTitle}" to "${safe}"`);
            } catch (err) {
              if (!err.message?.includes('TOPIC_NOT_MODIFIED')) {
                console.warn(`Could not rename topic ${mapping.tg_topic_id}:`, err.message);
              }
            }
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

        const msgContent = unwrapped;

        // Self-healing topic recovery wrapper with full retry on network glitches
        const sendWithTopicRecovery = async (sendFn) => {
          try {
            return await retryTelegramCall(() => sendFn(topicId), 3, 1000);
          } catch (err) {
            if (err.description?.includes('message thread not found') || err.message?.includes('message thread not found')) {
              console.log(`⚠️ Topic ${topicId} for ${remoteJid} was deleted in Telegram. Recreating topic...`);
              const resolvedTitle = await resolveChatTitle(sock, remoteJid, senderName);
              const safeTitle = sanitizeTopicName(resolvedTitle);
              const newTopic = await retryTelegramCall(() => bot.telegram.createForumTopic(groupId, safeTitle), 3, 1000);
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

              mapping.tg_topic_id = newTopicId;
              mapping.chat_name = safeTitle;
              await ensurePinnedProfileCard(sock, bot, groupId, newTopicId, remoteJid, safeTitle).catch(() => {});

              return await retryTelegramCall(() => sendFn(newTopicId), 3, 1000);
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

          const replyMarkup = makeReplyMarkup(m.key, isFromMe, 'text', groupId, storageTopicId);
          sentTgMsg = await sendWithTopicRecovery((tid) =>
            bot.telegram.sendMessage(
              groupId,
              formatted,
              {
                message_thread_id: tid,
                parse_mode: 'HTML',
                reply_markup: replyMarkup
              }
            )
          );
        }
        // --- 2. Image Message ---
        else if (msgContent.imageMessage) {
          mediaType = 'image';
          bodyText = msgContent.imageMessage.caption || '';
          const buffer = await downloadWaMedia(m, sock);
          const replyMarkup = makeReplyMarkup(m.key, isFromMe, 'image', groupId, storageTopicId);
          if (buffer) {
            sentTgMsg = await sendWithTopicRecovery((tid) =>
              bot.telegram.sendPhoto(
                groupId,
                { source: buffer, filename: 'photo.jpg' },
                {
                  message_thread_id: tid,
                  caption: `${prefix}${escapeHtml(bodyText)}`,
                  parse_mode: 'HTML',
                  reply_markup: replyMarkup
                }
              )
            );
            await mirrorMediaToStorage(bot, groupId, {
              mediaType: 'image',
              buffer,
              filename: 'photo.jpg',
              caption: bodyText,
              chatTitle: mapping.chat_name,
              senderName: isFromMe ? 'You' : senderName,
              timeStr: new Date().toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' })
            }).catch(() => {});
          } else {
            sentTgMsg = await sendWithTopicRecovery((tid) =>
              bot.telegram.sendMessage(
                groupId,
                `${prefix}📷 <i>[Photo - WhatsApp media stream pending or unavailable]</i>\n${escapeHtml(bodyText)}`.trim(),
                {
                  message_thread_id: tid,
                  parse_mode: 'HTML',
                  reply_markup: replyMarkup
                }
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
          const buffer = await downloadWaMedia(m, sock);
          const replyMarkup = makeReplyMarkup(m.key, isFromMe, 'document', groupId, storageTopicId);
          if (buffer) {
            sentTgMsg = await sendWithTopicRecovery((tid) =>
              bot.telegram.sendDocument(
                groupId,
                { source: buffer, filename: fileName },
                {
                  message_thread_id: tid,
                  caption: `${prefix}${escapeHtml(bodyText)}`,
                  parse_mode: 'HTML',
                  reply_markup: replyMarkup
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
          } else {
            const fileSize = doc.fileLength ? ` (${Math.round(doc.fileLength / 1024)} KB)` : '';
            sentTgMsg = await sendWithTopicRecovery((tid) =>
              bot.telegram.sendMessage(
                groupId,
                `${prefix}📄 <b>[Document: ${escapeHtml(fileName)}${fileSize}]</b>\n⚠️ <i>WhatsApp media stream pending or unavailable</i>\n${escapeHtml(bodyText)}`.trim(),
                {
                  message_thread_id: tid,
                  parse_mode: 'HTML',
                  reply_markup: replyMarkup
                }
              )
            );
          }
        }
        // --- 4. Audio / Voice Note ---
        else if (msgContent.audioMessage) {
          const isVoice = !!msgContent.audioMessage.ptt;
          mediaType = isVoice ? 'voice' : 'audio';
          const buffer = await downloadWaMedia(m, sock);
          const replyMarkup = makeReplyMarkup(m.key, isFromMe, mediaType, groupId, storageTopicId);
          if (buffer) {
            if (isVoice) {
              sentTgMsg = await sendWithTopicRecovery((tid) =>
                bot.telegram.sendVoice(
                  groupId,
                  { source: buffer, filename: 'voice.ogg' },
                  {
                    message_thread_id: tid,
                    caption: prefix ? prefix.trim() : undefined,
                    parse_mode: 'HTML',
                    reply_markup: replyMarkup
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
                    parse_mode: 'HTML',
                    reply_markup: replyMarkup
                  }
                )
              );
            }
            await mirrorMediaToStorage(bot, groupId, {
              mediaType: isVoice ? 'voice' : 'audio',
              buffer,
              filename: isVoice ? 'voice.ogg' : 'audio.mp3',
              caption: '',
              chatTitle: mapping.chat_name,
              senderName: isFromMe ? 'You' : senderName,
              timeStr: new Date().toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' })
            }).catch(() => {});
          } else {
            sentTgMsg = await sendWithTopicRecovery((tid) =>
              bot.telegram.sendMessage(
                groupId,
                `${prefix}🎤 <i>[Voice/Audio - WhatsApp media stream pending or unavailable]</i>`,
                {
                  message_thread_id: tid,
                  parse_mode: 'HTML',
                  reply_markup: replyMarkup
                }
              )
            );
          }
        }
        // --- 5. Video Message ---
        else if (msgContent.videoMessage) {
          mediaType = 'video';
          bodyText = msgContent.videoMessage.caption || '';
          const buffer = await downloadWaMedia(m, sock);
          const replyMarkup = makeReplyMarkup(m.key, isFromMe, 'video', groupId, storageTopicId);
          if (buffer) {
            sentTgMsg = await sendWithTopicRecovery((tid) =>
              bot.telegram.sendVideo(
                groupId,
                { source: buffer, filename: 'video.mp4' },
                {
                  message_thread_id: tid,
                  caption: `${prefix}${escapeHtml(bodyText)}`,
                  parse_mode: 'HTML',
                  reply_markup: replyMarkup
                }
              )
            );
            await mirrorMediaToStorage(bot, groupId, {
              mediaType: 'video',
              buffer,
              filename: 'video.mp4',
              caption: bodyText,
              chatTitle: mapping.chat_name,
              senderName: isFromMe ? 'You' : senderName,
              timeStr: new Date().toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' })
            }).catch(() => {});
          } else {
            sentTgMsg = await sendWithTopicRecovery((tid) =>
              bot.telegram.sendMessage(
                groupId,
                `${prefix}🎥 <i>[Video - WhatsApp media stream pending or unavailable]</i>\n${escapeHtml(bodyText)}`.trim(),
                {
                  message_thread_id: tid,
                  parse_mode: 'HTML',
                  reply_markup: replyMarkup
                }
              )
            );
          }
        }
        // --- 6. Sticker Message ---
        else if (msgContent.stickerMessage) {
          mediaType = 'sticker';
          const buffer = await downloadWaMedia(m, sock);
          const replyMarkup = makeReplyMarkup(m.key, isFromMe, 'sticker', groupId, storageTopicId);
          if (buffer) {
            sentTgMsg = await sendWithTopicRecovery((tid) =>
              bot.telegram.sendDocument(
                groupId,
                { source: buffer, filename: 'sticker.webp' },
                {
                  message_thread_id: tid,
                  caption: `${prefix}<i>[Sticker]</i>`,
                  parse_mode: 'HTML',
                  reply_markup: replyMarkup
                }
              )
            );
          }
        }
        // --- 7. Contact Card Message ---
        else if (msgContent.contactMessage || msgContent.contactsArrayMessage) {
          mediaType = 'contact';
          const contactsList = msgContent.contactsArrayMessage?.contacts || (msgContent.contactMessage ? [msgContent.contactMessage] : []);
          for (const card of contactsList) {
            const parsed = parseVCard(card.vcard, card.displayName);
            if (parsed.phone) {
              await saveContact({
                waId: `${parsed.phone}@s.whatsapp.net`,
                name: parsed.name,
                phoneNumber: parsed.phone
              });
            }

            let topicLink = '';
            if (parsed.phone) {
              const contactMapping = await getMappingByWaId(`${parsed.phone}@s.whatsapp.net`);
              if (contactMapping) {
                const cleanGroupId = String(groupId).replace(/^-100/, '');
                topicLink = `\n\n👉 <a href="https://t.me/c/${cleanGroupId}/${contactMapping.tg_topic_id}"><b>Click here to open WhatsApp Topic for ${escapeHtml(parsed.name)}</b></a>`;
              }
            }

            const formatted = `${prefix}👤 <b>Contact Shared:</b>\n` +
              `• <b>Name:</b> ${escapeHtml(parsed.name)}\n` +
              `• <b>Phone:</b> <code>+${escapeHtml(parsed.phone || 'N/A')}</code>` +
              topicLink;

            sentTgMsg = await sendWithTopicRecovery((tid) =>
              bot.telegram.sendMessage(groupId, formatted, {
                message_thread_id: tid,
                parse_mode: 'HTML'
              })
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
  if (isRelinkingWa || (now - lastRelinkTime < 8000)) {
    console.log('⚠️ Relink is already in progress, skipping duplicate call.');
    return;
  }
  isRelinkingWa = true;
  lastRelinkTime = now;

  console.log('🔄 Performing 100% full reset: deleting contacts, forum topics, and sessions...');

  // 1. Cancel any pending reconnect timer
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }

  // 2. Terminate existing socket cleanly
  if (sockInstance) {
    try {
      sockInstance._isClosing = true;
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

  hasAnnouncedConnected = false;
  connectionStatus.connected = false;
  connectionStatus.userJid = null;
  latestQrString = null;
  latestQrBuffer = null;
  storageTopicId = null;
  reconnectAttempts = 0;

  // 3. Delete all Telegram Forum Topics (except General Topic 1)
  try {
    const allMappings = await getAllMappings();
    console.log(`🧹 Deleting ${allMappings.length} existing Telegram forum topics...`);
    for (const m of allMappings) {
      const tid = Number(m.tg_topic_id);
      if (tid && tid > 1) {
        try {
          await bot.telegram.deleteForumTopic(groupId, tid);
          await new Promise(r => setTimeout(r, 250)); // Respect Telegram rate limits
        } catch (err) {
          console.warn(`Could not delete topic ${tid}:`, err.message);
        }
      }
    }
  } catch (err) {
    console.warn('Error deleting existing Telegram topics:', err.message);
  }

  // 4. Reset WhatsApp session and topics, but preserve and verify address book
  try {
    await client.execute({
      sql: 'DELETE FROM wa_auth_sessions WHERE session_id = ?',
      args: [sessionId]
    });
    await client.execute('DELETE FROM chat_mappings');
    await client.execute('DELETE FROM message_history');
    await seedContactsFromFile();
    console.log('✅ Session and topics reset; contacts address book verified and preserved.');
  } catch (err) {
    console.warn('Error clearing Turso tables on relink:', err.message);
  }

  // 5. Notify user in Telegram General Topic
  try {
    await retryTelegramCall(async () => {
      await bot.telegram.sendMessage(
        groupId,
        '🔄 <b>Fresh Relink Initialized:</b>\n\n' +
        '• WhatsApp session and forum topics have been reset.\n' +
        '• Address book contacts are preserved.\n' +
        '• Generating a fresh pairing QR code below.\n\n' +
        '📱 Scan the QR code in <b>WhatsApp > Linked Devices</b> to link fresh.\n' +
        '🌐 <b>Live Web View:</b> https://kezzy.onrender.com/qr',
        getTopicExtra(generalTopicId, { parse_mode: 'HTML' })
      );
    }, 2, 800);
  } catch (err) {
    console.warn('Could not send relink status notice to Telegram:', err.message);
  }

  // 6. Launch completely fresh WhatsApp connection
  setTimeout(() => {
    isRelinkingWa = false;
    initWhatsApp({ client, sessionId, bot, groupId, generalTopicId });
  }, 1500);
}
