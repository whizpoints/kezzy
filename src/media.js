import { downloadMediaMessage } from '@whiskeysockets/baileys';

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
    const buffer = await downloadMediaMessage(
      msg,
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
