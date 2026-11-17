import { downloadMediaMessage, extractMessageContent } from '@whiskeysockets/baileys';

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
 * Safely download media buffer from a Baileys message
 */
export async function downloadWaMedia(msg) {
  try {
    const unwrapped = unwrapWaMessage(msg.message);
    const buffer = await downloadMediaMessage(
      { key: msg.key, message: unwrapped },
      'buffer',
      {},
      {
        reuploadRequest: () => Promise.resolve()
      }
    );
    return buffer;
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
 * Fetch WhatsApp Profile Picture Buffer for a contact or group
 */
export async function getProfilePictureBuffer(sock, jid) {
  try {
    const url = await sock.profilePictureUrl(jid, 'image');
    if (!url) return null;
    const response = await fetch(url, { signal: AbortSignal.timeout(4000) });
    if (!response.ok) return null;
    const arrayBuffer = await response.arrayBuffer();
    return Buffer.from(arrayBuffer);
  } catch (err) {
    // Return null if user has privacy settings, no photo, or network timeout
    return null;
  }
}
