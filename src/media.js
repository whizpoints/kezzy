import { downloadMediaMessage, extractMessageContent, downloadContentFromMessage } from '@whiskeysockets/baileys';

/**
 * Unwrap nested WhatsApp messages (ephemeral, viewOnce, documentWithCaption, etc.)
 */
export function unwrapWaMessage(rawMessage) {
  if (!rawMessage) return {};
  let msg = rawMessage;

  while (
    msg?.ephemeralMessage?.message ||
    msg?.viewOnceMessage?.message ||
    msg?.viewOnceMessageV2?.message ||
    msg?.viewOnceMessageV2Extension?.message ||
    msg?.documentWithCaptionMessage?.message ||
    msg?.templateMessage?.hydratedTemplate ||
    msg?.templateMessage?.hydratedFourRowTemplate
  ) {
    if (msg.ephemeralMessage?.message) msg = msg.ephemeralMessage.message;
    else if (msg.viewOnceMessage?.message) msg = msg.viewOnceMessage.message;
    else if (msg.viewOnceMessageV2?.message) msg = msg.viewOnceMessageV2.message;
    else if (msg.viewOnceMessageV2Extension?.message) msg = msg.viewOnceMessageV2Extension.message;
    else if (msg.documentWithCaptionMessage?.message) msg = msg.documentWithCaptionMessage.message;
    else break;
  }

  return msg;
}

/**
 * Parse name and phone number from a WhatsApp vCard string
 */
export function parseVCard(vcard, fallbackName = '') {
  let name = fallbackName || 'Contact';
  let phone = null;

  if (vcard) {
    const fnMatch = vcard.match(/FN:(.+)/i);
    if (fnMatch) name = fnMatch[1].trim();

    const waidMatch = vcard.match(/waid=(\d+)/i);
    if (waidMatch) {
      phone = waidMatch[1].trim();
    } else {
      const telMatch = vcard.match(/TEL[^:]*:(.+)/i);
      if (telMatch) {
        phone = telMatch[1].replace(/[^\d]/g, '').trim();
      }
    }
  }

  return { name, phone };
}

/**
 * Clean phone number and convert to WhatsApp JID
 */
export function formatToWhatsAppJid(input) {
  let cleaned = input.replace(/[^\d]/g, '');
  if (!cleaned) return null;
  return `${cleaned}@s.whatsapp.net`;
}

/**
 * Format topic title to comply with Telegram rules (Max 128 chars, no control chars)
 */
export function sanitizeTopicName(name) {
  if (!name) return 'Unknown Chat';
  let clean = name.replace(/[\r\n\t]/g, ' ').trim();
  if (clean.length > 120) {
    clean = clean.substring(0, 117) + '...';
  }
  return clean || 'Chat';
}

/**
 * Safely download media buffer from a Baileys message with automatic re-upload support & direct stream fallback
 */
export async function downloadWaMedia(msg, sock = null) {
  try {
    if (!msg || !msg.message) return null;
    const unwrapped = unwrapWaMessage(msg.message);
    if (!unwrapped || Object.keys(unwrapped).length === 0) return null;

    const mediaMessage = {
      key: msg.key,
      message: unwrapped
    };

    // Strategy 1: Baileys downloadMediaMessage with logger & re-upload
    try {
      const buffer = await downloadMediaMessage(
        mediaMessage,
        'buffer',
        { timeout: 35000 },
        {
          logger: {
            info: () => {},
            warn: () => {},
            error: () => {},
            debug: () => {},
            trace: () => {}
          },
          reuploadRequest: sock ? async (m) => {
            try {
              console.log(`🔄 Requesting WhatsApp media re-upload for ${m.key?.id}...`);
              return await sock.updateMediaMessage(m);
            } catch (reErr) {
              console.warn(`Media re-upload failed for ${m.key?.id}:`, reErr.message);
              return m;
            }
          } : undefined
        }
      );
      if (buffer && buffer.length > 0) return buffer;
    } catch (primaryErr) {
      console.warn(`Primary media download note (${primaryErr.message}). Attempting direct stream fallback...`);
    }

    // Strategy 2: Direct stream extraction via downloadContentFromMessage
    const contentType = Object.keys(unwrapped).find(k => k.endsWith('Message') && k !== 'extendedTextMessage' && k !== 'conversation');
    if (contentType) {
      const mediaObj = unwrapped[contentType];
      const type = contentType.replace('Message', '').toLowerCase();
      const validTypes = {
        image: 'image',
        document: 'document',
        audio: 'audio',
        video: 'video',
        sticker: 'sticker'
      };
      const streamType = validTypes[type] || 'document';
      if (mediaObj && (mediaObj.url || mediaObj.directPath) && mediaObj.mediaKey) {
        try {
          const stream = await downloadContentFromMessage(mediaObj, streamType, { timeout: 30000 });
          const chunks = [];
          for await (const chunk of stream) {
            chunks.push(chunk);
          }
          const directBuf = Buffer.concat(chunks);
          if (directBuf && directBuf.length > 0) return directBuf;
        } catch (directErr) {
          console.warn(`Direct stream download failed:`, directErr.message);
        }
      }
    }

    return null;
  } catch (err) {
    console.error('Error downloading WhatsApp media:', err.message);
    return null;
  }
}

/**
 * Download a file from Telegram using native fetch
 */
export async function downloadTelegramFile(fileUrl) {
  const response = await fetch(fileUrl);
  if (!response.ok) {
    throw new Error(`Failed to download file from Telegram: ${response.statusText}`);
  }
  const arrayBuffer = await response.arrayBuffer();
  return Buffer.from(arrayBuffer);
}

/**
 * Escape HTML characters for Telegram formatting
 */
export function escapeHtml(text) {
  if (!text) return '';
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/**
 * Fetch WhatsApp Profile Picture Buffer for a contact or group with stylish avatar fallback
 */
export async function getProfilePictureBuffer(sock, jid, contactName = 'WhatsApp Contact', phoneNumber = null) {
  // 1. Prioritize real Phone JID or Group JID over anonymous @lid
  const candidateJids = [];
  if (phoneNumber) {
    const cleanPhone = String(phoneNumber).replace(/[^\d]/g, '');
    if (cleanPhone) candidateJids.push(`${cleanPhone}@s.whatsapp.net`);
  }
  if (jid) candidateJids.push(jid);

  if (sock) {
    for (const targetJid of candidateJids) {
      try {
        const url = await sock.profilePictureUrl(targetJid, 'image');
        if (url) {
          const response = await fetch(url, { signal: AbortSignal.timeout(6000) });
          if (response.ok) {
            const arrayBuffer = await response.arrayBuffer();
            if (arrayBuffer.byteLength > 0) {
              console.log(`📸 Fetched real WhatsApp profile picture for ${targetJid}`);
              return Buffer.from(arrayBuffer);
            }
          }
        }
      } catch (_) {}
    }
  }

  // 2. High-resolution avatar fallback (if no photo or privacy blocked)
  try {
    const palette = ['0088cc', '128C7E', '25D366', '34B7F1', '075E54', '4B6584', '20BF6B', '8854D0'];
    const cleanName = (contactName || 'Contact').replace(/[^\w\s]/gi, '').trim() || 'Contact';
    const color = palette[Math.abs(cleanName.split('').reduce((acc, char) => acc + char.charCodeAt(0), 0)) % palette.length];
    const avatarUrl = `https://ui-avatars.com/api/?name=${encodeURIComponent(cleanName)}&size=512&background=${color}&color=fff&bold=true`;

    const res = await fetch(avatarUrl, { signal: AbortSignal.timeout(4000) });
    if (res.ok) {
      const arrayBuf = await res.arrayBuffer();
      return Buffer.from(arrayBuf);
    }
  } catch (_) {}

  return null;
}
