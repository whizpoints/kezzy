import 'dotenv/config';
import { Telegraf } from 'telegraf';
import { initDb, getAllMappings, getContact } from '../src/db.js';

async function main() {
  console.log('🚀 Completing Profile Cards for Remaining Topics...');

  const dbUrl = process.env.TURSO_DATABASE_URL;
  const dbAuthToken = process.env.TURSO_AUTH_TOKEN;
  const botToken = process.env.TELEGRAM_BOT_TOKEN;
  const groupId = process.env.TELEGRAM_GROUP_ID;

  initDb({ url: dbUrl, authToken: dbAuthToken });
  const bot = new Telegraf(botToken);

  const mappings = await getAllMappings();

  // Target the remaining topics: 976, 992, 937, 905
  const remainingIds = [976, 992, 937, 905];
  const targetMappings = mappings.filter(m => remainingIds.includes(m.tg_topic_id));

  for (const m of targetMappings) {
    const contact = await getContact(m.wa_id);
    const name = contact?.name || m.chat_name.replace(/\s*\(\+.*\)/, '') || 'WhatsApp Contact';
    const phone = contact?.phone_number || (m.wa_id.includes('@s.whatsapp.net') ? m.wa_id.split('@')[0] : null);

    console.log(`📸 Generating profile card for topic ${m.tg_topic_id}: "${name}" (+${phone || 'N/A'})...`);

    let sent = false;
    while (!sent) {
      try {
        const palette = ['0088cc', '128C7E', '25D366', '34B7F1', '075E54', '4B6584', '20BF6B', '8854D0'];
        const color = palette[Math.abs(name.split('').reduce((acc, char) => acc + char.charCodeAt(0), 0)) % palette.length];
        const avatarUrl = `https://ui-avatars.com/api/?name=${encodeURIComponent(name)}&size=512&background=${color}&color=fff&bold=true&rounded=false`;

        const res = await fetch(avatarUrl);
        const arrayBuf = await res.arrayBuffer();
        const buffer = Buffer.from(arrayBuf);

        const caption =
          `👤 <b>${name}</b>\n` +
          `📞 <code>+${phone || 'Unsaved'}</code>\n` +
          `💬 <b>WhatsApp Direct Chat</b>\n\n` +
          `📌 <i>Pinned Profile Card</i>`;

        const card = await bot.telegram.sendPhoto(
          groupId,
          { source: buffer, filename: 'profile.png' },
          {
            message_thread_id: m.tg_topic_id,
            caption,
            parse_mode: 'HTML'
          }
        );

        await bot.telegram.pinChatMessage(groupId, card.message_id, {
          disable_notification: true
        });

        console.log(`✅ Pinned profile card in topic ${m.tg_topic_id} for "${name}".`);
        sent = true;
        await new Promise(r => setTimeout(r, 2000));
      } catch (err) {
        const retryAfter = err?.parameters?.retry_after || 32;
        console.log(`⏳ Rate limited. Waiting ${retryAfter}s before retrying topic ${m.tg_topic_id}...`);
        await new Promise(r => setTimeout(r, (retryAfter + 1) * 1000));
      }
    }
  }

  console.log('🎉 All remaining topics now have pinned profile cards!');
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
