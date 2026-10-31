const DEFAULT_BOT_TOKEN = "PASTE_YOUR_BOT_TOKEN_HERE";
const DEFAULT_GEMINI_KEY = "PASTE_YOUR_GEMINI_KEY_HERE";
const CHANNEL_USERNAME = "@SrBotsClub";
const ADMIN_ID = 5527067319;

// In-memory cache + persistent fallback
const SITE_CACHE = new Map();
const MEM_USERS = new Set([ADMIN_ID]);
const MEM_STATS = {
  sites_created: 0,
  edits: 0
};
let ADMIN_BROADCAST_MODE = false;
let CACHED_MODELS = null;

export default {
  async fetch(request, env) {
    const botToken = (env && env.BOT_TOKEN ? env.BOT_TOKEN : DEFAULT_BOT_TOKEN).trim();
    const geminiKey = (env && env.GEMINI_KEY ? env.GEMINI_KEY : DEFAULT_GEMINI_KEY).trim();
    const db = env && env.BOT_DB ? env.BOT_DB : null;
    const url = new URL(request.url);

    // 1. Setup & Diagnostic Route
    if (url.pathname === "/setup") {
      if (!botToken || botToken.includes("PASTE_YOUR")) {
        return new Response(
          "<h2>⚠️ BOT_TOKEN Missing!</h2><p>Please add <b>BOT_TOKEN</b> in Cloudflare Settings &rarr; Variables and Secrets.</p>",
          { headers: { "content-type": "text/html; charset=utf-8" } }
        );
      }

      const webhookUrl = `${url.origin}/webhook`;
      const tgRes = await fetch(
        `https://api.telegram.org/bot${botToken}/setWebhook?url=${encodeURIComponent(webhookUrl)}&drop_pending_updates=true`
      );
      const tgData = await tgRes.json();

      let html = `<h2>${tgData.ok ? "✅ Instant AI Website Creator Live!" : "❌ Telegram Token Error"}</h2>`;
      html += `<p><b>Telegram Status:</b> ${tgData.ok ? "Connected to " + CHANNEL_USERNAME : JSON.stringify(tgData)}</p>`;
      html += `<p><b>Admin ID Locked To:</b> ${ADMIN_ID}</p>`;
      html += `<p><b>Permanent Database (BOT_DB):</b> ${db ? "✅ Active & Permanent" : "⚠️ Running in RAM Mode"}</p>`;
      html += `<p><b>Hosting Domain:</b> ${url.origin}/site/[slug]</p>`;

      return new Response(html, { headers: { "content-type": "text/html; charset=utf-8" } });
    }

    // 2. Live Website Hosting Route (/site/:slug)
    if (url.pathname.startsWith("/site/")) {
      const slug = url.pathname.replace("/site/", "").trim().toLowerCase();
      let htmlContent = SITE_CACHE.get(slug);

      if (!htmlContent && db) {
        try {
          htmlContent = await db.get(`site_${slug}`);
          if (htmlContent) SITE_CACHE.set(slug, htmlContent);
        } catch (e) {}
      }

      if (htmlContent) {
        return new Response(htmlContent, {
          headers: {
            "content-type": "text/html; charset=utf-8",
            "cache-control": "public, max-age=3600"
          }
        });
      }

      return new Response(
        `<!DOCTYPE html><html><head><meta charset="utf-8"><title>Website Not Found</title><script src="https://cdn.tailwindcss.com"></script></head><body class="bg-slate-950 text-white min-h-screen flex items-center justify-center p-6 text-center"><div class="max-w-md bg-slate-900 border border-slate-800 rounded-2xl p-8 shadow-2xl"><h1 class="text-4xl font-extrabold text-cyan-400 mb-3">404</h1><h2 class="text-xl font-bold mb-2">Website Not Found</h2><p class="text-slate-400 text-sm mb-6">This website may have been moved or the link is incorrect.</p><a href="https://t.me/${CHANNEL_USERNAME.replace("@", "")}" class="inline-block bg-cyan-500 hover:bg-cyan-400 text-slate-950 font-semibold px-6 py-3 rounded-xl transition">Build Your Website Free</a></div></body></html>`,
        { status: 404, headers: { "content-type": "text/html; charset=utf-8" } }
      );
    }

    // 3. Telegram Webhook Handler
    if (request.method === "POST" && url.pathname === "/webhook") {
      try {
        const update = await request.json();
        await handleUpdate(update, botToken, geminiKey, db, url.origin);
      } catch (err) {
        console.error("Webhook error:", err);
      }
      return new Response("OK", { status: 200 });
    }

    return new Response(
      `⚡ Instant AI Website Builder is Running!\nVisit ${url.origin}/setup to verify webhook.`,
      { headers: { "content-type": "text/plain; charset=utf-8" } }
    );
  }
};

async function handleUpdate(update, botToken, geminiKey, db, originUrl) {
  // 1. Handle Callback Buttons
  if (update.callback_query) {
    const cb = update.callback_query;
    const chatId = cb.message.chat.id;
    const userId = cb.from.id;
    const data = cb.data || "";

    await registerUser(db, userId);

    if (data === "verify_join") {
      const joined = await isUserInChannel(botToken, userId);
      if (joined) {
        await tgApi(botToken, "answerCallbackQuery", {
          callback_query_id: cb.id,
          text: "✅ Verified! You can now build websites."
        });
        await sendWelcomeMenu(botToken, chatId, userId);
      } else {
        await tgApi(botToken, "answerCallbackQuery", {
          callback_query_id: cb.id,
          text: `⚠️ Please join ${CHANNEL_USERNAME} first, then tap Verify!`,
          show_alert: true
        });
      }
      return;
    }

    if (data.startsWith("demo_")) {
      const promptType = data.replace("demo_", "");
      let demoPrompt = "";
      if (promptType === "gym") {
        demoPrompt = "Modern unisex fitness gym named IronCore in Jaipur with 3 membership plans, trainer profiles, timetable, and WhatsApp join button.";
      } else if (promptType === "photo") {
        demoPrompt = "Luxury wedding and portrait photography portfolio named Lumina Moments in Udaipur with photo gallery, packages, and booking button.";
      } else if (promptType === "cafe") {
        demoPrompt = "Cozy rooftop cafe named Sunset Brew with coffee and snack menu, customer reviews, photo gallery, and reservation button.";
      }

      await tgApi(botToken, "answerCallbackQuery", {
        callback_query_id: cb.id,
        text: "⚡ Building your demo website..."
      });

      await generateAndDeployWebsite(botToken, geminiKey, db, chatId, userId, demoPrompt, originUrl);
      return;
    }

    // Admin Handlers (Locked to 5527067319)
    if (data.startsWith("admin_")) {
      if (userId !== ADMIN_ID) {
        await tgApi(botToken, "answerCallbackQuery", {
          callback_query_id: cb.id,
          text: "⛔ Unauthorized: Admin only.",
          show_alert: true
        });
        return;
      }

      if (data === "admin_panel" || data === "admin_refresh") {
        await tgApi(botToken, "answerCallbackQuery", {
          callback_query_id: cb.id,
          text: "📊 Refreshing live stats..."
        });
        await sendAdminPanel(botToken, db, chatId, cb.message.message_id);
        return;
      }

      if (data === "admin_export_users") {
        await tgApi(botToken, "answerCallbackQuery", {
          callback_query_id: cb.id,
          text: "📥 Exporting user database..."
        });
        await exportUsersFile(botToken, db, chatId);
        return;
      }

      if (data === "admin_broadcast_start") {
        ADMIN_BROADCAST_MODE = true;
        if (db) await db.put("admin_broadcast_mode", "true");
        await tgApi(botToken, "answerCallbackQuery", {
          callback_query_id: cb.id,
          text: "📢 Broadcast Mode Activated!"
        });
        await tgApi(botToken, "sendMessage", {
          chat_id: chatId,
          text: "📢 *Admin Broadcast Mode Active*\n\nSend or forward *any message* right now to broadcast it to all bot users!\n\n_Tap Cancel below if you change your mind._",
          parse_mode: "Markdown",
          reply_markup: {
            inline_keyboard: [[{ text: "❌ Cancel Broadcast", callback_data: "admin_broadcast_cancel" }]]
          }
        });
        return;
      }

      if (data === "admin_broadcast_cancel") {
        ADMIN_BROADCAST_MODE = false;
        if (db) await db.put("admin_broadcast_mode", "false");
        await tgApi(botToken, "answerCallbackQuery", {
          callback_query_id: cb.id,
          text: "Broadcast cancelled."
        });
        await tgApi(botToken, "sendMessage", {
          chat_id: chatId,
          text: "✅ *Broadcast Cancelled.*",
          parse_mode: "Markdown"
        });
        return;
      }
      return;
    }
    return;
  }

  // 2. Handle Text Messages
  const msg = update.message;
  if (!msg || !msg.chat) return;

  const chatId = msg.chat.id;
  const userId = msg.from ? msg.from.id : chatId;
  const text = (msg.text || msg.caption || "").trim();

  await registerUser(db, userId);

  // Admin Commands & Broadcast Interceptor
  if (userId === ADMIN_ID) {
    if (text === "/stats" || text === "/admin") {
      ADMIN_BROADCAST_MODE = false;
      if (db) await db.put("admin_broadcast_mode", "false");
      await sendAdminPanel(botToken, db, chatId, null);
      return;
    }

    if (text === "/cancel") {
      ADMIN_BROADCAST_MODE = false;
      if (db) await db.put("admin_broadcast_mode", "false");
      await tgApi(botToken, "sendMessage", {
        chat_id: chatId,
        text: "✅ *Broadcast mode cancelled.*",
        parse_mode: "Markdown"
      });
      return;
    }

    if (text.startsWith("/broadcast ")) {
      const bText = text.replace("/broadcast ", "").trim();
      if (bText) {
        await executeBroadcastText(botToken, db, chatId, bText);
        return;
      }
    }

    const isBroadcastActive =
      ADMIN_BROADCAST_MODE || (db && (await db.get("admin_broadcast_mode")) === "true");

    if (isBroadcastActive && !text.startsWith("/")) {
      ADMIN_BROADCAST_MODE = false;
      if (db) await db.put("admin_broadcast_mode", "false");
      await executeBroadcastCopy(botToken, db, chatId, msg.message_id);
      return;
    }
  }

  // Force-Join Channel Gatekeeper
  const isMember = await isUserInChannel(botToken, userId);
  if (!isMember) {
    const channelHandle = CHANNEL_USERNAME.replace("@", "");
    await tgApi(botToken, "sendMessage", {
      chat_id: chatId,
      text: `🔒 *Welcome to Instant AI Website Creator!*\n\nTo build and host free live websites, please join our official hub ${CHANNEL_USERNAME} first:`,
      parse_mode: "Markdown",
      reply_markup: {
        inline_keyboard: [
          [{ text: `📢 Join ${CHANNEL_USERNAME}`, url: `https://t.me/${channelHandle}` }],
          [{ text: "✅ I Joined — Unlock Bot", callback_data: "verify_join" }]
        ]
      }
    });
    return;
  }

  if (text === "/start" || text === "/help") {
    await sendWelcomeMenu(botToken, chatId, userId);
    return;
  }

  if (!text) return;

  // Generate and Deploy Live Website from Casual Prompt
  await generateAndDeployWebsite(botToken, geminiKey, db, chatId, userId, text, originUrl);
}

// Welcome Menu with Demo Templates
async function sendWelcomeMenu(botToken, chatId, userId) {
  const channelHandle = CHANNEL_USERNAME.replace("@", "");
  const keyboard = [
    [
      { text: "🏋️ Demo: Gym Landing Page", callback_data: "demo_gym" },
      { text: "📸 Demo: Photography Portfolio", callback_data: "demo_photo" }
    ],
    [
      { text: "☕ Demo: Cafe & Restaurant", callback_data: "demo_cafe" },
      { text: `📢 Official Hub (${CHANNEL_USERNAME})`, url: `https://t.me/${channelHandle}` }
    ]
  ];

  if (userId === ADMIN_ID) {
    keyboard.push([{ text: "🛠️ Admin Panel & Broadcast (Owner Only)", callback_data: "admin_panel" }]);
  }

  await tgApi(botToken, "sendMessage", {
    chat_id: chatId,
    text: `🚀 *Instant AI Website Creator*\n\nDescribe the website you want in casual English or Hindi:\n\n• *Business:* Gym, Cafe, Restaurant, Dental Clinic\n• *Portfolio:* Photography, Freelancer, Coding, Resume\n• *Store / Agency:* Clothing Brand, Real Estate, Consulting\n\n_Example: "Create a modern dark-mode website for a sneaker store named KicksHub in Jaipur with product cards and WhatsApp order button."_\n\n👇 *Send your prompt now or try a demo template below:*`,
    parse_mode: "Markdown",
    reply_markup: { inline_keyboard: keyboard }
  });
}

// Main AI Generation & Deployment Pipeline
async function generateAndDeployWebsite(botToken, geminiKey, db, chatId, userId, userPrompt, originUrl) {
  const statusMsg = await tgApi(botToken, "sendMessage", {
    chat_id: chatId,
    text: "⚙️ _Designing your website layout, mobile-responsive CSS & components... (Takes ~8 seconds)_",
    parse_mode: "Markdown"
  });

  const rawHtml = await generateWebsiteCodeWithGemini(geminiKey, userPrompt);

  if (statusMsg.result?.message_id) {
    await tgApi(botToken, "deleteMessage", {
      chat_id: chatId,
      message_id: statusMsg.result.message_id
    });
  }

  if (!rawHtml || rawHtml.length < 200) {
    await tgApi(botToken, "sendMessage", {
      chat_id: chatId,
      text: "😕 *Could not generate website code.* Please try again with a slightly more detailed prompt!",
      parse_mode: "Markdown"
    });
    return;
  }

  // Generate URL slug and embed watermark
  const cleanSlug = generateSlugFromPrompt(userPrompt);
  const finalHtml = injectBrandingFooter(rawHtml);

  // Store permanently in KV database & fast RAM
  SITE_CACHE.set(cleanSlug, finalHtml);
  if (db) {
    try {
      await db.put(`site_${cleanSlug}`, finalHtml);
      await incrementStat(db, "sites_created");
    } catch (e) {}
  }

  const liveUrl = `${originUrl}/site/${cleanSlug}`;
  const shareText = encodeURIComponent(`Check out my new website built in 10 seconds with @InstantMP3SongBot 🚀: ${liveUrl}`);
  const shareUrl = `https://t.me/share/url?url=${encodeURIComponent(liveUrl)}&text=${shareText}`;
  const channelHandle = CHANNEL_USERNAME.replace("@", "");

  const actionButtons = {
    inline_keyboard: [
      [
        { text: "🌐 Open Live Website", url: liveUrl },
        { text: "📲 Share Website", url: shareUrl }
      ],
      [{ text: `📢 Official Hub (${CHANNEL_USERNAME})`, url: `https://t.me/${channelHandle}` }]
    ]
  };

  let caption = `🎉 *Your Website is Live & Hosted Online!*\n\n`;
  caption += `🔗 *Live Link:* \`${liveUrl}\`\n\n`;
  caption += `✨ *Features Included:*\n`;
  caption += `• Mobile-Responsive Modern Layout\n`;
  caption += `• Tailwind CSS Styling & Glassmorphic Cards\n`;
  caption += `• Interactive WhatsApp Action Buttons\n`;
  caption += `• Hosted 24/7 with 0ms Load Time\n\n`;
  caption += `_Tap "Open Live Website" below to see it live in your browser!_`;

  // 1. Send confirmation with interactive buttons
  await tgApi(botToken, "sendMessage", {
    chat_id: chatId,
    text: caption,
    parse_mode: "Markdown",
    reply_markup: actionButtons
  });

  // 2. Send index.html file so user can download the raw source code
  try {
    const form = new FormData();
    form.append("chat_id", String(chatId));
    form.append("caption", `📄 *index.html* source code for your website.`);
    form.append("parse_mode", "Markdown");
    form.append("document", new Blob([finalHtml], { type: "text/html" }), `${cleanSlug}.html`);

    await fetch(`https://api.telegram.org/bot${botToken}/sendDocument`, {
      method: "POST",
      body: form
    });
  } catch (e) {}
}

// Master AI Prompt for Production-Grade HTML5/Tailwind Websites
async function generateWebsiteCodeWithGemini(geminiKey, userPrompt) {
  const systemPrompt = `You are an elite principal web designer and frontend architect.
The user wants a website described as: "${userPrompt}".

Create a single, complete, production-ready, beautiful, mobile-first HTML5 file.

Requirements:
1. Load Tailwind CSS via CDN: <script src="https://cdn.tailwindcss.com"></script>
2. Load FontAwesome Icons: <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.4.0/css/all.min.css">
3. Choose a sleek, modern palette (e.g. slate-950/cyan for modern tech/fitness, warm amber/stone for cafes, cream/gold for luxury/photography).
4. Include rich, realistic sections:
   - Modern Sticky Navbar with logo and mobile menu
   - Hero Section with bold typography, badges, and call-to-action buttons
   - Features / Services Grid with high-contrast glassmorphic cards
   - Pricing or Menu or Gallery Grid (with realistic items, prices in ₹ / $, and highlights)
   - Testimonials / Social Proof with star ratings
   - Interactive FAQ Section with vanilla JS toggle
   - Direct WhatsApp / Contact button: href="https://wa.me/919876543210?text=Hello%20I%20am%20interested"
   - Polished Footer
5. Include functional Vanilla JavaScript for mobile menu toggles and FAQ accordion expand/collapse.
6. Make it completely self-contained. Return ONLY valid raw HTML code without markdown code fences, no backticks, no conversational commentary.`;

  const models = await getAvailableFlashModels(geminiKey);
  for (const model of models) {
    try {
      const res = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${geminiKey}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            contents: [{ parts: [{ text: systemPrompt }] }],
            generationConfig: { temperature: 0.3 }
          })
        }
      );
      if (!res.ok) continue;
      const data = await res.json();
      let text = data.candidates?.[0]?.content?.parts?.[0]?.text || "";
      text = text.replace(/^```html\s*/i, "").replace(/```\s*$/i, "").trim();
      if (text.includes("<html") || text.includes("<!DOCTYPE")) {
        return text;
      }
    } catch (e) {}
  }
  return null;
}

// Generates a Clean URL Slug from User Prompt
function generateSlugFromPrompt(prompt) {
  const words = prompt
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, "")
    .trim()
    .split(/\s+/)
    .slice(0, 3)
    .join("-");
  const rand = Math.random().toString(36).slice(2, 6);
  return `${words || "site"}-${rand}`;
}

// Injects Sleek Watermark Badge into Footer
function injectBrandingFooter(html) {
  const badge = `
  <div style="position:fixed;bottom:12px;right:12px;z-index:9999;font-family:sans-serif;">
    <a href="https://t.me/${CHANNEL_USERNAME.replace("@", "")}" target="_blank" style="display:flex;align-items:center;gap:6px;background:rgba(15,23,42,0.85);backdrop-filter:blur(8px);border:1px solid rgba(255,255,255,0.15);padding:6px 12px;border-radius:999px;color:#fff;text-decoration:none;font-size:12px;box-shadow:0 4px 12px rgba(0,0,0,0.3);">
      <span style="color:#38bdf8;">⚡ Built with</span>
      <span style="font-weight:700;">${CHANNEL_USERNAME}</span>
    </a>
  </div>
  `;
  if (html.includes("</body>")) {
    return html.replace("</body>", `${badge}</body>`);
  }
  return html + badge;
}

// Model Fallback Discovery
async function getAvailableFlashModels(geminiKey) {
  if (CACHED_MODELS && CACHED_MODELS.length > 0) return CACHED_MODELS;
  try {
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models?key=${geminiKey}`
    );
    if (res.ok) {
      const data = await res.json();
      const allModels = (data.models || [])
        .filter(
          m =>
            Array.isArray(m.supportedGenerationMethods) &&
            m.supportedGenerationMethods.includes("generateContent") &&
            m.name.includes("gemini") &&
            !m.name.includes("tts") &&
            !m.name.includes("image") &&
            !m.name.includes("embedding") &&
            !m.name.includes("robotics") &&
            !m.name.includes("computer-use") &&
            !m.name.includes("1.5")
        )
        .map(m => m.name.replace(/^models\//, ""));

      allModels.sort((a, b) => (a.includes("flash") ? 0 : 1) - (b.includes("flash") ? 0 : 1));

      if (allModels.length > 0) {
        CACHED_MODELS = allModels.slice(0, 6);
        return CACHED_MODELS;
      }
    }
  } catch (e) {}
  return ["gemini-2.5-flash", "gemini-2.0-flash"];
}

// User Registration in KV Database
async function registerUser(db, userId) {
  if (!userId) return;
  const numId = Number(userId);
  MEM_USERS.add(numId);

  if (db) {
    try {
      const existing = await db.get(`u_${numId}`);
      if (!existing) {
        await db.put(`u_${numId}`, new Date().toISOString().slice(0, 10));
        const raw = await db.get("master_users_list");
        const list = raw ? JSON.parse(raw) : [ADMIN_ID];
        if (!list.includes(numId)) {
          list.push(numId);
          await db.put("master_users_list", JSON.stringify(list));
        }
      }
    } catch (e) {}
  }
}

async function getAllUsers(db) {
  if (db) {
    try {
      const raw = await db.get("master_users_list");
      if (raw) {
        const list = JSON.parse(raw);
        list.forEach(id => MEM_USERS.add(Number(id)));
      }
    } catch (e) {}
  }
  return Array.from(MEM_USERS);
}

async function incrementStat(db, key) {
  MEM_STATS[key] = (MEM_STATS[key] || 0) + 1;
  if (db) {
    try {
      const cur = Number((await db.get(`stat_${key}`)) || 0) + 1;
      await db.put(`stat_${key}`, String(cur));
    } catch (e) {}
  }
}

async function getStatsData(db) {
  const users = await getAllUsers(db);
  let sites = MEM_STATS.sites_created;
  if (db) {
    try {
      const s = await db.get("stat_sites_created");
      if (s) sites = Math.max(sites, Number(s));
    } catch (e) {}
  }
  return {
    userCount: users.length,
    sites
  };
}

async function getChannelMemberCount(botToken) {
  try {
    const res = await tgApi(botToken, "getChatMemberCount", {
      chat_id: CHANNEL_USERNAME
    });
    if (res && res.ok) return res.result;
  } catch (e) {}
  return null;
}

async function isUserInChannel(botToken, userId) {
  try {
    const res = await tgApi(botToken, "getChatMember", {
      chat_id: CHANNEL_USERNAME,
      user_id: userId
    });
    if (!res.ok || !res.result) return true;
    const status = res.result.status;
    return status === "member" || status === "administrator" || status === "creator";
  } catch (e) {}
  return true;
}

// Exports User List as .txt Document
async function exportUsersFile(botToken, db, adminChatId) {
  const users = await getAllUsers(db);
  const fileContent = users.join("\n");

  const form = new FormData();
  form.append("chat_id", String(adminChatId));
  form.append("caption", `📊 *AI Website Builder — User Database Export*\nTotal Unique Users: ${users.length}\nDate: ${new Date().toISOString().slice(0, 10)}`);
  form.append("parse_mode", "Markdown");
  form.append("document", new Blob([fileContent], { type: "text/plain" }), "users_list.txt");

  await fetch(`https://api.telegram.org/bot${botToken}/sendDocument`, {
    method: "POST",
    body: form
  });
}

// Broadcast Message Copy Engine
async function executeBroadcastCopy(botToken, db, adminChatId, messageId) {
  const users = await getAllUsers(db);
  const statusMsg = await tgApi(botToken, "sendMessage", {
    chat_id: adminChatId,
    text: `⏳ _Broadcasting message to ${users.length} registered users..._`,
    parse_mode: "Markdown"
  });

  let sent = 0;
  let failed = 0;

  for (const uid of users) {
    try {
      const res = await tgApi(botToken, "copyMessage", {
        chat_id: uid,
        from_chat_id: adminChatId,
        message_id: messageId
      });
      if (res && res.ok) sent++;
      else failed++;
    } catch (e) {
      failed++;
    }
  }

  if (statusMsg.result?.message_id) {
    await tgApi(botToken, "deleteMessage", {
      chat_id: adminChatId,
      message_id: statusMsg.result.message_id
    });
  }

  await tgApi(botToken, "sendMessage", {
    chat_id: adminChatId,
    text: `✅ *Broadcast Complete!*\n\n• 📬 *Delivered:* ${sent} users\n• 🚫 *Failed / Blocked:* ${failed} users\n• 📊 *Total Target Base:* ${users.length} users`,
    parse_mode: "Markdown"
  });
}

async function executeBroadcastText(botToken, db, adminChatId, text) {
  const users = await getAllUsers(db);
  let sent = 0;
  let failed = 0;

  for (const uid of users) {
    try {
      const res = await tgApi(botToken, "sendMessage", {
        chat_id: uid,
        text: text,
        parse_mode: "Markdown"
      });
      if (res && res.ok) sent++;
      else failed++;
    } catch (e) {
      failed++;
    }
  }

  await tgApi(botToken, "sendMessage", {
    chat_id: adminChatId,
    text: `✅ *Broadcast Complete!*\n\n• 📬 *Delivered:* ${sent} users\n• 🚫 *Failed:* ${failed} users`,
    parse_mode: "Markdown"
  });
}

async function sendAdminPanel(botToken, db, chatId, editMsgId) {
  const stats = await getStatsData(db);
  const channelMembers = await getChannelMemberCount(botToken);

  let text = `🛠️ *SR Bots Club — Website Creator Admin Panel*\n`;
  text += `👤 *Admin ID:* \`${ADMIN_ID}\`\n\n`;
  text += `📊 *Detailed Live Statistics:*\n`;
  text += `• 👥 *Total Unique Bot Users:* ${stats.userCount}\n`;
  if (channelMembers) {
    text += `• 📢 *${CHANNEL_USERNAME} Subscribers:* ${channelMembers}\n`;
  }
  text += `• 🌐 *Total Websites Created & Hosted:* ${stats.sites}\n`;
  text += `• 💾 *Storage Engine:* ${db ? "Permanent Cloudflare KV (`BOT_DB`)" : "⚠️ RAM Mode"}\n\n`;
  text += `_Tap a button below to broadcast an announcement, export your user list, or refresh stats:_`;

  const reply_markup = {
    inline_keyboard: [
      [{ text: "📢 Broadcast to All Users", callback_data: "admin_broadcast_start" }],
      [
        { text: "📥 Export Users (.txt)", callback_data: "admin_export_users" },
        { text: "🔄 Refresh Stats", callback_data: "admin_refresh" }
      ]
    ]
  };

  if (editMsgId) {
    await tgApi(botToken, "editMessageText", {
      chat_id: chatId,
      message_id: editMsgId,
      text: text,
      parse_mode: "Markdown",
      reply_markup: reply_markup
    });
  } else {
    await tgApi(botToken, "sendMessage", {
      chat_id: chatId,
      text: text,
      parse_mode: "Markdown",
      reply_markup: reply_markup
    });
  }
}

async function tgApi(botToken, method, payload) {
  const res = await fetch(`https://api.telegram.org/bot${botToken}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });
  return await res.json();
}
