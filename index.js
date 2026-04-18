const { Client, GatewayIntentBits, EmbedBuilder } = require('discord.js');
const https = require('https');
const fs = require('fs');

// ─── Config ───
const TOKEN = process.env.DISCORD_BOT_TOKEN;
const REVIEW_CHANNEL_ID = process.env.REVIEW_CHANNEL_ID || '';
const OPS_CHANNEL_ID = process.env.OPS_CHANNEL_ID || '';
const MAX_SLOTS_PER_DAY = parseInt(process.env.MAX_SLOTS || '3', 10);
const RESET_HOUR_UTC = parseInt(process.env.RESET_HOUR_UTC || '22', 10); // 3 PM PT = 22 UTC (PDT)
const DATA_FILE = './data.json';

// ─── State ───
let state = {
  approvedToday: [],      // [{ userId, url, orderId, timestamp }]
  allUrls: [],            // all-time submitted URLs (dedup)
  lastReset: null,        // ISO string of last reset
  userSubmittedToday: [],  // userIds who already submitted today
  submissions: []          // all-time log: [{ userId, username, url, orderId, verified, timestamp }]
};

// Pending order ID collection: userId -> { url, messageId, timeout }
const pendingOrderId = new Map();
const ORDER_ID_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes to provide order ID

function loadState() {
  try {
    if (fs.existsSync(DATA_FILE)) {
      const raw = fs.readFileSync(DATA_FILE, 'utf8');
      const loaded = JSON.parse(raw);
      state = { ...state, ...loaded };
      // Ensure submissions array exists for upgrades from old data
      if (!state.submissions) state.submissions = [];
    }
  } catch (e) {
    console.error('Failed to load state:', e.message);
  }
}

function saveState() {
  try {
    fs.writeFileSync(DATA_FILE, JSON.stringify(state, null, 2));
  } catch (e) {
    console.error('Failed to save state:', e.message);
  }
}

// ─── Daily Reset ───
function checkReset() {
  const now = new Date();
  const lastReset = state.lastReset ? new Date(state.lastReset) : null;

  const todayReset = new Date(Date.UTC(
    now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), RESET_HOUR_UTC, 0, 0
  ));

  if (now >= todayReset && (!lastReset || lastReset < todayReset)) {
    state.approvedToday = [];
    state.userSubmittedToday = [];
    state.lastReset = now.toISOString();
    saveState();
    console.log(`Daily reset at ${now.toISOString()}`);
  }
}

// ─── Trustpilot URL Validation ───
function isValidTrustpilotUrl(url) {
  try {
    const parsed = new URL(url);
    return (
      parsed.protocol === 'https:' &&
      (parsed.hostname === 'trustpilot.com' ||
       parsed.hostname === 'www.trustpilot.com' ||
       parsed.hostname.endsWith('.trustpilot.com'))
    );
  } catch {
    return false;
  }
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

// Fetch page and verify it mentions Tapin
function verifyReviewMentionsTapin(url) {
  return new Promise((resolve) => {
    try {
      const parsed = new URL(url);
      if (!parsed.hostname.endsWith('trustpilot.com')) {
        return resolve({ verified: false });
      }

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
            if (!redirectUrl.hostname.endsWith('trustpilot.com')) {
              return resolve({ verified: false });
            }
          } catch {
            return resolve({ verified: false });
          }
        }

        let body = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => {
          body += chunk;
          if (body.length > 500000) req.destroy();
        });
        res.on('end', () => {
          const lower = body.toLowerCase();
          const isTapin = lower.includes('tapin');

          // Try to extract reviewer name and star rating from page
          let reviewerName = null;
          let starRating = null;

          // Extract reviewer name from various patterns
          const nameMatch = body.match(/data-consumer-name="([^"]+)"/i) ||
                           body.match(/"displayName"\s*:\s*"([^"]+)"/i) ||
                           body.match(/by\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+)?)\s*<\/span/i);
          if (nameMatch) reviewerName = nameMatch[1];

          // Extract star rating
          const ratingMatch = body.match(/data-rating="(\d)"/i) ||
                             body.match(/"ratingValue"\s*:\s*(\d)/i) ||
                             body.match(/gave\s+tapin\.gg\s+(\d)\s+star/i);
          if (ratingMatch) starRating = parseInt(ratingMatch[1]);

          resolve({ verified: isTapin, reviewerName, starRating });
        });
      });

      req.on('error', () => resolve({ verified: false }));
      req.on('timeout', () => { req.destroy(); resolve({ verified: false }); });
      req.end();
    } catch {
      resolve({ verified: false });
    }
  });
}

// ─── Order ID Validation ───
function isValidOrderId(text) {
  const trimmed = text.trim();
  // Accept numeric order IDs (common format) or alphanumeric with reasonable length
  return /^\d{3,10}$/.test(trimmed) || /^[A-Za-z0-9_-]{3,20}$/.test(trimmed);
}

// ─── Bot ───
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent
  ]
});

client.once('ready', () => {
  console.log(`Logged in as ${client.user.tag}`);
  loadState();
  checkReset();
  setInterval(checkReset, 60000);
});

client.on('messageCreate', async (message) => {
  if (message.author.bot) return;

  // ─── Admin commands (ops channel) ───
  if (message.channel.id === OPS_CHANNEL_ID) {
    const content = message.content.trim().toLowerCase();

    if (content === '!tp-status') {
      const slotsUsed = state.approvedToday.length;
      const remaining = MAX_SLOTS_PER_DAY - slotsUsed;
      const todayList = state.approvedToday.map((s, i) =>
        `${i + 1}. <@${s.userId}> — Order \`${s.orderId}\` — ${s.url}`
      ).join('\n') || 'None yet';

      await message.reply({
        embeds: [new EmbedBuilder()
          .setTitle('📊 Trustpilot Review Status')
          .setColor(remaining > 0 ? 0x00ff00 : 0xff0000)
          .addFields(
            { name: 'Slots Used', value: `${slotsUsed}/${MAX_SLOTS_PER_DAY}`, inline: true },
            { name: 'Remaining', value: `${remaining}`, inline: true },
            { name: 'Total All-Time', value: `${state.submissions.length}`, inline: true },
            { name: "Today's Approvals", value: todayList }
          )
          .setTimestamp()
        ]
      });
      return;
    }

    if (content === '!tp-reset') {
      state.approvedToday = [];
      state.userSubmittedToday = [];
      state.lastReset = new Date().toISOString();
      saveState();
      await message.reply('✅ Daily slots reset. All 3 slots available now.');
      return;
    }

    if (content === '!tp-log') {
      const recent = state.submissions.slice(-10).reverse();
      if (recent.length === 0) {
        await message.reply('No submissions logged yet.');
        return;
      }
      const logText = recent.map((s, i) => {
        const date = new Date(s.timestamp).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
        return `${i + 1}. <@${s.userId}> — Order \`${s.orderId}\` — ${s.starRating ? '⭐'.repeat(s.starRating) : '?'} — ${date}`;
      }).join('\n');

      await message.reply({
        embeds: [new EmbedBuilder()
          .setTitle('📋 Recent Submissions (last 10)')
          .setDescription(logText)
          .setColor(0x5865f2)
          .setTimestamp()
        ]
      });
      return;
    }

    if (content === '!tp-help') {
      await message.reply({
        embeds: [new EmbedBuilder()
          .setTitle('🤖 Trustpilot Bot Commands')
          .setDescription(
            '`!tp-status` — View today\'s slots and approvals\n' +
            '`!tp-reset` — Manually reset daily slots\n' +
            '`!tp-log` — View last 10 submissions (all-time)\n' +
            '`!tp-help` — Show this help message'
          )
          .setColor(0x5865f2)
        ]
      });
      return;
    }
  }

  // ─── Review submissions (review channel only) ───
  if (message.channel.id !== REVIEW_CHANNEL_ID) return;

  checkReset();
  const userId = message.author.id;

  // ─── Check if user is providing an order ID (pending flow) ───
  if (pendingOrderId.has(userId)) {
    const pending = pendingOrderId.get(userId);
    const text = message.content.trim();

    if (!isValidOrderId(text)) {
      await message.reply('❌ That doesn\'t look like a valid order ID. Please paste the **order number** from your session (e.g. `12345`).');
      return;
    }

    const orderId = text.trim();
    clearTimeout(pending.timeout);
    pendingOrderId.delete(userId);

    // ─── Complete the submission ───
    const submission = {
      userId,
      username: message.author.username,
      url: pending.url,
      orderId,
      reviewerName: pending.reviewerName || null,
      starRating: pending.starRating || null,
      verified: true,
      timestamp: new Date().toISOString()
    };

    state.approvedToday.push(submission);
    state.userSubmittedToday.push(userId);
    state.allUrls.push(pending.url);
    state.submissions.push(submission);
    saveState();

    const slotsLeft = MAX_SLOTS_PER_DAY - state.approvedToday.length;

    await message.react('✅');
    await message.reply(
      `✅ **Review submitted!** Order \`${orderId}\` logged.\n` +
      `You'll receive $1 credit, and your teammate gets $1 too! 🎉\n` +
      `**${slotsLeft} slot${slotsLeft !== 1 ? 's' : ''} remaining today.**`
    );

    // ─── Notify ops ───
    if (OPS_CHANNEL_ID) {
      try {
        const opsChannel = await client.channels.fetch(OPS_CHANNEL_ID);
        if (opsChannel) {
          const embed = new EmbedBuilder()
            .setTitle('⭐ New Verified Review')
            .setColor(0x00ff00)
            .addFields(
              { name: 'Teammate', value: `<@${userId}>`, inline: true },
              { name: 'Order ID', value: `\`${orderId}\``, inline: true },
              { name: 'Slots Left', value: `${slotsLeft}/${MAX_SLOTS_PER_DAY}`, inline: true },
              { name: 'Link', value: pending.url }
            )
            .setTimestamp();

          if (pending.reviewerName) embed.addFields({ name: 'Reviewer', value: pending.reviewerName, inline: true });
          if (pending.starRating) embed.addFields({ name: 'Rating', value: '⭐'.repeat(pending.starRating), inline: true });

          await opsChannel.send({ embeds: [embed] });
        }
      } catch (e) {
        console.error('Failed to notify ops:', e.message);
      }
    }
    return;
  }

  // ─── New review link submission ───
  const url = extractTrustpilotUrl(message.content);

  if (!url) {
    if (message.attachments.size > 0) {
      await message.reply('📎 Please paste your **Trustpilot review link** instead of a screenshot. Example: `https://www.trustpilot.com/reviews/...`');
    }
    return;
  }

  // ─── Checks ───
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

  // ─── Validate review ───
  await message.react('🔍');
  const { verified, reviewerName, starRating } = await verifyReviewMentionsTapin(url);
  if (!verified) {
    await message.reply('❌ Couldn\'t verify this is a Tapin review. Make sure the link goes directly to your Trustpilot review of Tapin.gg.');
    return;
  }

  // ─── Ask for order ID ───
  const verifiedMsg = reviewerName && starRating
    ? `🔍 **Review verified!** (${reviewerName} — ${'⭐'.repeat(starRating)})\n\n`
    : '🔍 **Review link verified!**\n\n';

  await message.reply(
    verifiedMsg +
    '📝 Now please reply with the **order ID** for the session this review is about.\n' +
    'You can find it in your order history. Example: `12345`\n\n' +
    '⏰ You have 5 minutes to provide the order ID.'
  );

  // Store pending state with timeout
  const timeout = setTimeout(async () => {
    pendingOrderId.delete(userId);
    try {
      const channel = await client.channels.fetch(REVIEW_CHANNEL_ID);
      if (channel) {
        await channel.send(`⏰ <@${userId}> Your review submission timed out — you didn't provide an order ID in time. Please submit again!`);
      }
    } catch (e) {
      console.error('Timeout notification failed:', e.message);
    }
  }, ORDER_ID_TIMEOUT_MS);

  pendingOrderId.set(userId, {
    url,
    messageId: message.id,
    reviewerName,
    starRating,
    timeout
  });
});

// ─── Start ───
if (!TOKEN) {
  console.error('DISCORD_BOT_TOKEN environment variable is required');
  process.exit(1);
}

client.login(TOKEN);
