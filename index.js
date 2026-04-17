const { Client, GatewayIntentBits, EmbedBuilder } = require('discord.js');
const https = require('https');
const fs = require('fs');

// ─── Config ───
const TOKEN = process.env.DISCORD_BOT_TOKEN;
const REVIEW_CHANNEL_ID = process.env.REVIEW_CHANNEL_ID || '';
const OPS_CHANNEL_ID = process.env.OPS_CHANNEL_ID || '';
const MAX_SLOTS_PER_DAY = parseInt(process.env.MAX_SLOTS || '3', 10);
const RESET_HOUR_UTC = parseInt(process.env.RESET_HOUR_UTC || '22', 10);
const DATA_FILE = './data.json';
let state = {
  approvedToday: [],
  allUrls: [],
  lastReset: null,
  userSubmittedToday: []
};

function loadState() {
  try {
    if (fs.existsSync(DATA_FILE)) {
      const raw = fs.readFileSync(DATA_FILE, 'utf8');
      const loaded = JSON.parse(raw);
      state = { ...state, ...loaded };
    }
      } catch (e) { console.error('Failed to load state:', e.message); }
}

function saveState() {
  try { fs.writeFileSync(DATA_FILE, JSON.stringify(state, null, 2)); }
  catch (e) { console.error('Failed to save state:', e.message); }
}

function checkReset() {
  const now = new Date();
  const lastReset = state.lastReset ? new Date(state.lastReset) : null;
  const todayReset = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), RESET_HOUR_UTC, 0, 0));
  if (now >= todayReset && (!lastReset || lastReset < todayReset)) {
    state.approvedToday = [];
    state.userSubmittedToday = [];
        state.lastReset = now.toISOString();
    saveState();
    console.log(`Daily reset at ${now.toISOString()}`);
  }
}

function isValidTrustpilotUrl(url) {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'https:' &&
      (parsed.hostname === 'trustpilot.com' ||
       parsed.hostname === 'www.trustpilot.com' ||
       parsed.hostname.endsWith('.trustpilot.com'));
  } catch { return false; }
}
function extractTrustpilotUrl(text) {
  const urlRegex = /https?:\/\/[^\s<>]+trustpilot\.com[^\s<>]*/gi;
  const matches = text.match(urlRegex);
  if (!matches) return null;
  for (const url of matches) {
    if (isValidTrustpilotUrl(url)) return url;
  }
  return null;
}

function verifyReviewMentionsTapin(url) {
  return new Promise((resolve) => {
    try {
      const parsed = new URL(url);
            if (!parsed.hostname.endsWith('trustpilot.com')) return resolve(false);
      const options = {
        hostname: parsed.hostname,
        path: parsed.pathname + parsed.search,
        method: 'GET',
        headers: { 'User-Agent': 'TapinReviewBot/1.0' },
        timeout: 8000
      };
      const req = https.request(options, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          try {
            const redirectUrl = new URL(res.headers.location, url);
            if (!redirectUrl.hostname.endsWith('trustpilot.com')) return resolve(false);
          } catch { return resolve(false); }
        }
                let body = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => { body += chunk; if (body.length > 500000) req.destroy(); });
        res.on('end', () => resolve(body.toLowerCase().includes('tapin')));
      });
      req.on('error', () => resolve(false));
      req.on('timeout', () => { req.destroy(); resolve(false); });
      req.end();
    } catch { resolve(false); }
  });
}

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent]
});
client.once('ready', () => {
  console.log(`Logged in as ${client.user.tag}`);
  loadState();
  checkReset();
  setInterval(checkReset, 60000);
});

client.on('messageCreate', async (message) => {
  if (message.author.bot) return;

  if (message.channel.id === OPS_CHANNEL_ID) {
    const content = message.content.trim().toLowerCase();
    if (content === '!tp-status') {
      const slotsUsed = state.approvedToday.length;
            const remaining = MAX_SLOTS_PER_DAY - slotsUsed;
      const todayList = state.approvedToday.map((s, i) => `${i + 1}. <@${s.userId}> — ${s.url}`).join('\n') || 'None yet';
      await message.reply({ embeds: [new EmbedBuilder().setTitle('📊 Trustpilot Review Status').setColor(remaining > 0 ? 0x00ff00 : 0xff0000)
        .addFields({ name: 'Slots Used', value: `${slotsUsed}/${MAX_SLOTS_PER_DAY}`, inline: true }, { name: 'Remaining', value: `${remaining}`, inline: true },
          { name: 'Total All-Time URLs', value: `${state.allUrls.length}`, inline: true }, { name: "Today's Approvals", value: todayList }).setTimestamp()] });
      return;
    }
    if (content === '!tp-reset') {
      state.approvedToday = []; state.userSubmittedToday = []; state.lastReset = new Date().toISOString(); saveState();
      await message.reply('✅ Daily slots reset. All 3 slots available now.');
      return;
    }
    if (content === '!tp-help') {
      await message.reply({ embeds: [new EmbedBuilder().setTitle('🤖 Trustpilot Bot Commands')
        .setDescription('`!tp-status` — View today\'s slots and approvals\n`!tp-reset` — Manually reset daily slots\n`!tp-help` — Show this help message').setColor(0x5865f2)] });
            return;
    }
  }

  if (message.channel.id !== REVIEW_CHANNEL_ID) return;
  checkReset();

  const url = extractTrustpilotUrl(message.content);

  if (!url) {
    if (message.attachments.size > 0) {
      await message.reply('📎 Please paste your **Trustpilot review link** instead of a screenshot. Example: `https://www.trustpilot.com/reviews/...`');
    }
    return;
  }
    const userId = message.author.id;

  if (state.userSubmittedToday.includes(userId)) {
    await message.reply('⏳ You already submitted a review today! Come back after the daily reset (3 PM PT).');
    return;
  }
  if (state.approvedToday.length >= MAX_SLOTS_PER_DAY) {
    await message.reply(`😔 All ${MAX_SLOTS_PER_DAY} slots for today are taken! Try again after 3 PM PT.`);
    return;
  }
  if (state.allUrls.includes(url)) {
    await message.reply('🔁 This review link has already been submitted before.');
    return;
  }
    await message.react('🔍');
  const verified = await verifyReviewMentionsTapin(url);
  if (!verified) {
    await message.reply('❌ Couldn\'t verify this is a Tapin review. Make sure the link goes directly to your Trustpilot review of Tapin.gg.');
    return;
  }

  state.approvedToday.push({ userId, url, timestamp: new Date().toISOString() });
  state.userSubmittedToday.push(userId);
  state.allUrls.push(url);
  saveState();

  const slotsLeft = MAX_SLOTS_PER_DAY - state.approvedToday.length;
  await message.react('✅');
    await message.reply(`✅ **Review verified!** You'll receive $1 credit, and your teammate gets $1 too! 🎉\n**${slotsLeft} slot${slotsLeft !== 1 ? 's' : ''} remaining today.**`);

  if (OPS_CHANNEL_ID) {
    try {
      const opsChannel = await client.channels.fetch(OPS_CHANNEL_ID);
      if (opsChannel) {
        await opsChannel.send({ embeds: [new EmbedBuilder().setTitle('⭐ New Verified Review').setColor(0x00ff00)
          .addFields({ name: 'User', value: `<@${userId}>`, inline: true }, { name: 'Slots Left', value: `${slotsLeft}/${MAX_SLOTS_PER_DAY}`, inline: true },
            { name: 'Link', value: url }).setTimestamp()] });
      }
    } catch (e) { console.error('Failed to notify ops:', e.message); }
  }
});

if (!TOKEN) { console.error('DISCORD_BOT_TOKEN environment variable is required'); process.exit(1); }
client.login(TOKEN);
