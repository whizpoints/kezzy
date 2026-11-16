import { Telegraf } from 'telegraf';
import {
  getMappingByTopicId,
  getMappingByWaId,
  saveMapping,
  getMessageHistoryByTgId,
  saveMessageHistory,
  searchContacts,
  updateMappingName,
  saveContact,
  getContact
} from './db.js';
import { formatToWhatsAppJid, sanitizeTopicName, downloadTelegramFile, getProfilePictureBuffer } from './media.js';
import { recordBotSentMessage, syncContactsAndTopics, syncAllGroups } from './whatsapp.js';

let botInstance = null;
let currentGroupId = null;
let currentGeneralTopicId = 1;

function getReplyExtra(ctx, extra = {}) {
  const result = { ...extra };
  if (ctx.message?.message_thread_id && ctx.message.message_thread_id > 1) {
    result.message_thread_id = ctx.message.message_thread_id;
  }
  return result;
}

export function getTelegramBot() {
  return botInstance;
}

export function initTelegramBot({ botToken, groupId, generalTopicId = 1, getWaSocket, getWaStatus, onRelink }) {
  if (!botToken || !groupId) {
    throw new Error('TELEGRAM_BOT_TOKEN and TELEGRAM_GROUP_ID are required.');
  }

  const bot = new Telegraf(botToken);
  botInstance = bot;
  currentGroupId = groupId.toString();
  currentGeneralTopicId = parseInt(generalTopicId, 10) || 1;

  // Middleware: Only process messages in the designated supergroup
  bot.use(async (ctx, next) => {
    if (!ctx.chat) return next();

    // If message is in private chat with bot, advise them to use the group
    if (ctx.chat.type === 'private') {
      return ctx.reply(
        '👋 Welcome! This bot operates inside your dedicated WhatsApp Telegram Forum group.\n\n' +
        'Add this bot as an Administrator with "Manage Topics" permission to your Forum Supergroup.'
      );
    }

    // Check if message is in the configured supergroup
    if (ctx.chat.id.toString() !== currentGroupId) {
      return; // Ignore other groups
    }

    return next();
  });

  // ================= COMMANDS ================= //

  bot.command('start', async (ctx) => {
    await ctx.reply(
      '🌟 <b>WhatsApp-Telegram Bridge Active</b>\n\n' +
      '• Each WhatsApp contact and group has its own <b>Topic</b>.\n' +
      '• Send messages directly in any topic to reply on WhatsApp.\n\n' +
      '<b>Commands:</b>\n' +
      '• <code>/addcontact &lt;Name&gt; [Phone]</code> - Add/save contact & rename topic\n' +
      '• <code>/sync_groups</code> - Sync & import all WhatsApp groups into topics\n' +
      '• <code>/sync</code> - Sync contact names and audit all topic titles\n' +
      '• <code>/rename &lt;name&gt;</code> - Rename current topic and contact\n' +
      '• <code>/chat &lt;phone&gt; [name]</code> - Start a new WhatsApp chat\n' +
      '• <code>/search &lt;query&gt;</code> - Search synced WhatsApp contacts\n' +
      '• <code>/status</code> - Check WhatsApp connection & statistics\n' +
      '• <code>/relink</code> - Reset session & re-sync 31 days with full photos/docs\n' +
      '• <code>/help</code> - Show this guide',
      getReplyExtra(ctx, {
        parse_mode: 'HTML'
      })
    );
  });

  bot.command('help', async (ctx) => {
    await ctx.reply(
      '📖 <b>How to Use:</b>\n\n' +
      '1. <b>Add/Sync Contact:</b> Inside any topic, type <code>/addcontact Alex 254712345678</code> or <code>/addcontact Alex</code>. It saves the contact to your database and updates the topic title.\n' +
      '2. <b>Sync All Groups:</b> Type <code>/sync_groups</code> to import all your WhatsApp groups into topics with photos.\n' +
      '3. <b>Re-sync 31 Days with Media:</b> Type <code>/relink</code> to get a fresh QR code that re-downloads your 31-day history with real photos, documents, and voice notes.\n' +
      '4. <b>Rename Topic:</b> Inside any topic, type <code>/rename New Name (+Phone)</code>.\n' +
      '5. <b>Start a chat:</b> Type <code>/chat 254712345678 Alex</code> in General topic.\n' +
      '6. <b>Replying:</b> Simply type text, attach files, photos, or voice notes inside any topic.',
      getReplyExtra(ctx, {
        parse_mode: 'HTML'
      })
    );
  });

  // /addcontact <Name> [Phone] inside topic, or /addcontact <Phone> <Name> in General
  bot.command(['addcontact', 'savecontact', 'contact'], async (ctx) => {
    const topicId = ctx.message.message_thread_id;
    const rawText = ctx.message.text.replace(/^\/(addcontact|savecontact|contact)(@\w+)?\s*/i, '').trim();

    if (!rawText) {
      if (topicId && topicId !== currentGeneralTopicId) {
        return ctx.reply(
          '⚠️ <b>Usage inside a topic:</b>\n<code>/addcontact &lt;Name&gt; [Phone]</code>\nExample: <code>/addcontact Alex 254712345678</code> or <code>/addcontact Alex</code>',
          getReplyExtra(ctx, { parse_mode: 'HTML' })
        );
      } else {
        return ctx.reply(
          '⚠️ <b>Usage in General:</b>\n<code>/addcontact &lt;Phone&gt; &lt;Name&gt;</code>\nExample: <code>/addcontact 254712345678 Alex</code>',
          getReplyExtra(ctx, { parse_mode: 'HTML' })
        );
      }
    }

    // Inside a specific topic
    if (topicId && topicId !== currentGeneralTopicId) {
      const mapping = await getMappingByTopicId(topicId);
      if (!mapping) {
        return ctx.reply('❌ This topic is not mapped to any WhatsApp chat.', getReplyExtra(ctx));
      }

      const parts = rawText.split(/\s+/);
      let phonePart = null;
      let nameParts = [];

      for (const p of parts) {
        const cleanDigits = p.replace(/[^\d]/g, '');
        if (cleanDigits.length >= 8 && /^\+?\d+$/.test(p)) {
          phonePart = cleanDigits;
        } else {
          nameParts.push(p);
        }
      }

      const name = nameParts.join(' ').trim() || (phonePart ? `Contact ${phonePart.slice(-4)}` : mapping.chat_name);

      if (!phonePart) {
        if (mapping.wa_id.endsWith('@s.whatsapp.net')) {
          phonePart = mapping.wa_id.split('@')[0]?.split(':')[0];
        } else {
          const existingContact = await getContact(mapping.wa_id);
          phonePart = existingContact?.phone_number || null;
        }
      }

      const phoneDisplay = phonePart ? ` (+${phonePart})` : '';
      const safeTitle = sanitizeTopicName(`${name}${phoneDisplay}`);

      try {
        await saveContact({
          waId: mapping.wa_id,
          name,
          phoneNumber: phonePart,
          lid: mapping.wa_id.endsWith('@lid') ? mapping.wa_id : null
        });

        if (phonePart) {
          const phoneJid = `${phonePart}@s.whatsapp.net`;
          await saveContact({
            waId: phoneJid,
            name,
            phoneNumber: phonePart,
            lid: mapping.wa_id.endsWith('@lid') ? mapping.wa_id : null
          });
        }

        await bot.telegram.editForumTopic(currentGroupId, topicId, { name: safeTitle });
        await updateMappingName(mapping.wa_id, safeTitle);

        await ctx.reply(
          `✅ <b>Contact Saved & Synced!</b>\n\n` +
          `• <b>Name:</b> ${name}\n` +
          `• <b>Phone:</b> ${phonePart ? `+${phonePart}` : 'Not specified'}\n` +
          `• <b>Topic:</b> <code>${safeTitle}</code>`,
          getReplyExtra(ctx, { parse_mode: 'HTML' })
        );
      } catch (err) {
        await ctx.reply(`❌ Failed to save contact: ${err.message}`, getReplyExtra(ctx));
      }
      return;
    }

    // In General topic (/addcontact <Phone> <Name>)
    const parts = rawText.split(/\s+/);
    const first = parts[0];
    const rest = parts.slice(1).join(' ').trim();
    const cleanDigits = first.replace(/[^\d]/g, '');

    if (cleanDigits.length < 8) {
      return ctx.reply('⚠️ Please provide a valid phone number with country code: <code>/addcontact 254712345678 Alex</code>', getReplyExtra(ctx, { parse_mode: 'HTML' }));
    }

    const name = rest || `Contact ${cleanDigits.slice(-4)}`;
    const waJid = `${cleanDigits}@s.whatsapp.net`;

    try {
      await saveContact({
        waId: waJid,
        name,
        phoneNumber: cleanDigits
      });

      const existing = await getMappingByWaId(waJid);
      if (existing) {
        const safeTitle = sanitizeTopicName(`${name} (+${cleanDigits})`);
        await bot.telegram.editForumTopic(currentGroupId, existing.tg_topic_id, { name: safeTitle });
        await updateMappingName(waJid, safeTitle);
      }

      await ctx.reply(
        `✅ <b>Contact Saved!</b>\n\n` +
        `• <b>Name:</b> ${name}\n` +
        `• <b>Phone:</b> +${cleanDigits}\n` +
        `You can now start a chat with <code>/chat ${cleanDigits}</code> or find them with <code>/search ${name}</code>.`,
        getReplyExtra(ctx, { parse_mode: 'HTML' })
      );
    } catch (err) {
      await ctx.reply(`❌ Failed to save contact: ${err.message}`, getReplyExtra(ctx));
    }
  });

  bot.command('sync_groups', async (ctx) => {
    const sock = getWaSocket();
    if (!sock) {
      return ctx.reply('🔴 WhatsApp is not connected. Please wait for reconnection.', getReplyExtra(ctx));
    }
    await ctx.reply('⏳ <b>Syncing all WhatsApp groups...</b>\nFetching all participating groups and creating forum topics...', getReplyExtra(ctx, { parse_mode: 'HTML' }));
    try {
      const { total, created, updated } = await syncAllGroups(sock, bot, currentGroupId);
      await ctx.reply(
        `✅ <b>Groups Sync Complete!</b>\n\n` +
        `• Total WhatsApp Groups: <b>${total}</b>\n` +
        `• New Topics Created: <b>${created}</b>\n` +
        `• Existing Topics Updated: <b>${updated}</b>`,
        getReplyExtra(ctx, { parse_mode: 'HTML' })
      );
    } catch (err) {
      await ctx.reply(`❌ Group sync error: ${err.message}`, getReplyExtra(ctx));
    }
  });

  bot.command(['sync', 'update_topics'], async (ctx) => {
    const sock = getWaSocket();
    if (!sock) {
      return ctx.reply('🔴 WhatsApp is not connected. Please wait for reconnection.', getReplyExtra(ctx));
    }
    await ctx.reply('⏳ <b>Syncing contacts, groups, and updating forum topics...</b>', getReplyExtra(ctx, { parse_mode: 'HTML' }));
    try {
      const { contactsCount, renamedCount } = await syncContactsAndTopics(sock, bot, currentGroupId);
      const groupsResult = await syncAllGroups(sock, bot, currentGroupId);
      await ctx.reply(
        `✅ <b>Sync Complete!</b>\n\n` +
        `• Audited Topics: <b>${contactsCount}</b>\n` +
        `• Renamed Topics: <b>${renamedCount}</b>\n` +
        `• Synced Groups: <b>${groupsResult.total}</b> (${groupsResult.created} new topics created)`,
        getReplyExtra(ctx, { parse_mode: 'HTML' })
      );
    } catch (err) {
      await ctx.reply(`❌ Sync error: ${err.message}`, getReplyExtra(ctx));
    }
  });

  bot.command('rename', async (ctx) => {
    const topicId = ctx.message.message_thread_id;
    if (!topicId || topicId === currentGeneralTopicId) {
      return ctx.reply('⚠️ Please use <code>/rename &lt;New Title&gt;</code> inside a specific chat topic.', getReplyExtra(ctx, { parse_mode: 'HTML' }));
    }
    const newName = ctx.message.text.replace(/^\/rename(@\w+)?\s*/i, '').trim();
    if (!newName) {
      return ctx.reply('⚠️ Usage: <code>/rename Alex (+254712345678)</code>', getReplyExtra(ctx, { parse_mode: 'HTML' }));
    }
    const mapping = await getMappingByTopicId(topicId);
    if (!mapping) {
      return ctx.reply('❌ This topic is not mapped to any WhatsApp chat.', getReplyExtra(ctx));
    }
    const safeTitle = sanitizeTopicName(newName);
    try {
      await bot.telegram.editForumTopic(currentGroupId, topicId, { name: safeTitle });
      await updateMappingName(mapping.wa_id, safeTitle);
      await saveContact({
        waId: mapping.wa_id,
        name: safeTitle
      });
      await ctx.reply(`✅ Topic successfully renamed to: <b>${safeTitle}</b>`, getReplyExtra(ctx, { parse_mode: 'HTML' }));
    } catch (err) {
      await ctx.reply(`❌ Failed to rename topic: ${err.message}`, getReplyExtra(ctx));
    }
  });

  bot.command('status', async (ctx) => {
    const status = getWaStatus();
    const sock = getWaSocket();
    const isConnected = !!(sock && status.connected);

    await ctx.reply(
      `📊 <b>System Status</b>\n\n` +
      `• <b>WhatsApp Connection:</b> ${isConnected ? '🟢 Connected' : '🔴 Disconnected'}\n` +
      `• <b>Account:</b> ${status.userJid || 'Not logged in'}\n` +
      `• <b>Uptime:</b> ${Math.floor(process.uptime())} seconds\n` +
      `• <b>Supergroup ID:</b> <code>${currentGroupId}</code>`,
      getReplyExtra(ctx, {
        parse_mode: 'HTML'
      })
    );
  });

  bot.command('relink', async (ctx) => {
    await ctx.reply(
      '🔄 <b>Resetting WhatsApp Session...</b>\nGenerating a brand new QR code to ingest your full message history.\nScan the new QR code in <b>Linked Devices</b> once it appears.',
      getReplyExtra(ctx, { parse_mode: 'HTML' })
    );
    if (onRelink) {
      await onRelink();
    }
  });

  bot.command('search', async (ctx) => {
    const query = ctx.message.text.replace('/search', '').trim();
    if (!query) {
      return ctx.reply('⚠️ Please provide a name or number to search: <code>/search John</code>', getReplyExtra(ctx, {
        parse_mode: 'HTML'
      }));
    }

    const results = await searchContacts(query);
    if (!results || results.length === 0) {
      return ctx.reply(`🔍 No contacts found matching "<b>${query}</b>".`, getReplyExtra(ctx, {
        parse_mode: 'HTML'
      }));
    }

    let response = `🔍 <b>Found ${results.length} contact(s):</b>\n\n`;
    for (const c of results) {
      const phone = c.phone_number || c.wa_id.split('@')[0];
      response += `• <b>${c.name || 'Unknown'}</b>: <code>${phone}</code>\n`;
      response += `  └ Start chat: <code>/chat ${phone} ${c.name || ''}</code>\n\n`;
    }

    await ctx.reply(response, getReplyExtra(ctx, {
      parse_mode: 'HTML'
    }));
  });

  bot.command('chat', async (ctx) => {
    const rawArgs = ctx.message.text.replace('/chat', '').trim().split(' ');
    const phoneInput = rawArgs[0];
    const nameInput = rawArgs.slice(1).join(' ').trim();

    if (!phoneInput) {
      return ctx.reply('⚠️ Usage: <code>/chat &lt;phone_with_country_code&gt; [Contact Name]</code>\nExample: <code>/chat 254712345678 Alex</code>', getReplyExtra(ctx, {
        parse_mode: 'HTML'
      }));
    }

    const waJid = formatToWhatsAppJid(phoneInput);
    if (!waJid) {
      return ctx.reply('❌ Invalid phone number. Please include the full country code (digits only).', getReplyExtra(ctx));
    }

    const sock = getWaSocket();
    if (!sock) {
      return ctx.reply('❌ WhatsApp is currently disconnected. Please wait for reconnection.', getReplyExtra(ctx));
    }

    // 1. Verify existence on WhatsApp
    try {
      const [onWa] = await sock.onWhatsApp(waJid);
      if (!onWa || !onWa.exists) {
        return ctx.reply(`❌ <code>${phoneInput}</code> is not registered on WhatsApp.`, getReplyExtra(ctx, {
          parse_mode: 'HTML'
        }));
      }
    } catch (err) {
      console.warn('Could not verify onWhatsApp status:', err.message);
    }

    // 2. Check if a topic already exists
    const existing = await getMappingByWaId(waJid);
    if (existing) {
      return ctx.reply(
        `💬 A topic already exists for this contact: <b>${existing.chat_name}</b>\n` +
        `Navigate to Topic ID: <code>${existing.tg_topic_id}</code>`,
        getReplyExtra(ctx, {
          parse_mode: 'HTML'
        })
      );
    }

    // 3. Create Forum Topic
    const topicTitle = sanitizeTopicName(nameInput || phoneInput);
    try {
      const topic = await bot.telegram.createForumTopic(currentGroupId, topicTitle);
      const topicId = topic.message_thread_id;

      // 4. Save mapping in DB
      await saveMapping({
        waId: waJid,
        topicId,
        chatName: topicTitle,
        isGroup: false
      });

      // 5. Send initial welcome in the new topic
      await bot.telegram.sendMessage(
        currentGroupId,
        `💬 <b>Chat created for ${topicTitle} (${phoneInput})</b>\n` +
        `Any message, document, or media sent here will be sent to WhatsApp.`,
        {
          message_thread_id: topicId,
          parse_mode: 'HTML'
        }
      );

      // Fetch & pin profile photo card
      const avatarBuffer = await getProfilePictureBuffer(sock, waJid);
      if (avatarBuffer) {
        const card = await bot.telegram.sendPhoto(
          currentGroupId,
          { source: avatarBuffer },
          {
            message_thread_id: topicId,
            caption: `📸 <b>${topicTitle}</b>\nWhatsApp: <code>${phoneInput}</code>`,
            parse_mode: 'HTML'
          }
        ).catch(() => null);

        if (card) {
          await bot.telegram.pinChatMessage(currentGroupId, card.message_id, {
            disable_notification: true
          }).catch(() => {});
        }
      }

      // 6. Confirm in General topic
      await ctx.reply(
        `✅ Created new topic: <b>${topicTitle}</b>! You can now start typing in that topic.`,
        getReplyExtra(ctx, {
          parse_mode: 'HTML'
        })
      );
    } catch (err) {
      console.error('Failed to create topic:', err);
      await ctx.reply(`❌ Failed to create topic: ${err.message}`, getReplyExtra(ctx));
    }
  });

  // Global error handler so errors never crash polling
  bot.catch((err, ctx) => {
    console.error(`Telegram bot error on update ${ctx?.update?.update_id}:`, err.message);
  });

  // ================= GENERAL MESSAGE ROUTING (Telegram -> WhatsApp) ================= //

  bot.on('message', async (ctx) => {
    const msg = ctx.message;
    const topicId = msg.message_thread_id;

    // Ignore bot's own messages and service events (topic created/edited, pins, member joins)
    if (
      msg.from?.is_bot ||
      msg.forum_topic_created ||
      msg.forum_topic_edited ||
      msg.forum_topic_closed ||
      msg.forum_topic_reopened ||
      msg.pinned_message ||
      msg.new_chat_members ||
      msg.left_chat_member
    ) {
      return;
    }

    // Ignore commands or messages sent in the General Control Topic
    if (!topicId || topicId === currentGeneralTopicId) {
      return;
    }

    // 1. Look up WhatsApp mapping for this topic
    const mapping = await getMappingByTopicId(topicId);
    if (!mapping) {
      // Don't spam or fail if topic is not mapped
      return;
    }

    // 2. Check Admin-Only restrictions for groups
    if (mapping.is_group && mapping.is_announcement && !mapping.is_admin) {
      return ctx.reply(
        '🔒 <b>Cannot Send:</b> This WhatsApp group is set to "Admins Only" and your account is not an admin.',
        {
          message_thread_id: topicId,
          parse_mode: 'HTML'
        }
      );
    }

    const sock = getWaSocket();
    if (!sock) {
      return ctx.reply('🔴 WhatsApp is not connected. Message could not be sent.', {
        message_thread_id: topicId
      });
    }

    // Resolve target WhatsApp JID: If mapping is an @lid, prefer verified phone JID for bulletproof WhatsApp encryption
    let targetJid = mapping.wa_id;
    if (targetJid.endsWith('@lid')) {
      try {
        const contact = await getContact(targetJid);
        if (contact && contact.phone_number) {
          targetJid = `${contact.phone_number}@s.whatsapp.net`;
        }
      } catch (_) {}
    }

    // 3. Handle Quoted Reply
    let quoted = undefined;
    if (msg.reply_to_message) {
      const historyItem = await getMessageHistoryByTgId(msg.reply_to_message.message_id);
      if (historyItem && historyItem.wa_message_id) {
        quoted = {
          key: {
            remoteJid: targetJid,
            id: historyItem.wa_message_id,
            fromMe: false
          },
          message: { conversation: historyItem.content_text || '' }
        };
      }
    }

    // Helper for transient timeout retry when sending to WhatsApp
    const sendWithWaRetry = async (fn, maxRetries = 2) => {
      for (let attempt = 0; attempt <= maxRetries; attempt++) {
        try {
          return await fn();
        } catch (err) {
          const isTimeout = err.message?.includes('Timed Out') || err.output?.statusCode === 408;
          if (isTimeout && attempt < maxRetries) {
            console.log(`WhatsApp send timed out (attempt ${attempt + 1}/${maxRetries}). Retrying...`);
            await new Promise(r => setTimeout(r, 1200));
            continue;
          }
          throw err;
        }
      }
    };

    try {
      let sentMsg = null;
      let mediaType = 'text';
      let contentText = msg.text || msg.caption || '';

      // --- TEXT MESSAGE ---
      if (msg.text) {
        sentMsg = await sendWithWaRetry(() =>
          sock.sendMessage(targetJid, { text: msg.text }, { quoted })
        );
      }
      // --- PHOTO ---
      else if (msg.photo && msg.photo.length > 0) {
        mediaType = 'image';
        const bestPhoto = msg.photo[msg.photo.length - 1];
        const fileLink = await ctx.telegram.getFileLink(bestPhoto.file_id);
        const buffer = await downloadTelegramFile(fileLink.href);

        sentMsg = await sendWithWaRetry(() =>
          sock.sendMessage(
            targetJid,
            { image: buffer, caption: msg.caption || '' },
            { quoted }
          )
        );
      }
      // --- DOCUMENT / FILE (PDF, DOCX, ZIP, etc.) ---
      else if (msg.document) {
        mediaType = 'document';
        const doc = msg.document;
        const fileLink = await ctx.telegram.getFileLink(doc.file_id);
        const buffer = await downloadTelegramFile(fileLink.href);

        sentMsg = await sendWithWaRetry(() =>
          sock.sendMessage(
            targetJid,
            {
              document: buffer,
              mimetype: doc.mime_type || 'application/octet-stream',
              fileName: doc.file_name || 'file',
              caption: msg.caption || ''
            },
            { quoted }
          )
        );
      }
      // --- VOICE NOTE ---
      else if (msg.voice) {
        mediaType = 'voice';
        const voice = msg.voice;
        const fileLink = await ctx.telegram.getFileLink(voice.file_id);
        const buffer = await downloadTelegramFile(fileLink.href);

        sentMsg = await sendWithWaRetry(() =>
          sock.sendMessage(
            targetJid,
            {
              audio: buffer,
              ptt: true,
              mimetype: 'audio/ogg; codecs=opus'
            },
            { quoted }
          )
        );
      }
      // --- AUDIO FILE ---
      else if (msg.audio) {
        mediaType = 'audio';
        const audio = msg.audio;
        const fileLink = await ctx.telegram.getFileLink(audio.file_id);
        const buffer = await downloadTelegramFile(fileLink.href);

        sentMsg = await sendWithWaRetry(() =>
          sock.sendMessage(
            targetJid,
            {
              audio: buffer,
              mimetype: audio.mime_type || 'audio/mp4',
              fileName: audio.file_name || 'audio.mp3',
              caption: msg.caption || ''
            },
            { quoted }
          )
        );
      }
      // --- VIDEO ---
      else if (msg.video) {
        mediaType = 'video';
        const video = msg.video;
        const fileLink = await ctx.telegram.getFileLink(video.file_id);
        const buffer = await downloadTelegramFile(fileLink.href);

        sentMsg = await sendWithWaRetry(() =>
          sock.sendMessage(
            targetJid,
            {
              video: buffer,
              caption: msg.caption || ''
            },
            { quoted }
          )
        );
      }

      // Record in message history and cache for retry re-encryption & echo suppression
      if (sentMsg) {
        recordBotSentMessage(sentMsg.key.id, sentMsg.message);
        await saveMessageHistory({
          waMessageId: sentMsg.key.id,
          tgMessageId: msg.message_id,
          waChatId: mapping.wa_id,
          tgTopicId: topicId,
          senderWaId: 'me',
          contentText,
          mediaType
        });
      }
    } catch (err) {
      console.error('Error forwarding message to WhatsApp:', err);
      await ctx.reply(`❌ Failed to send to WhatsApp: ${err.message}`, {
        message_thread_id: topicId
      });
    }
  });

  return bot;
}
