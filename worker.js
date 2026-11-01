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
const PROCESSED_UPDATES = new Set();
let ADMIN_BROADCAST_MODE = false;
let WORKING_MODEL = null;

// Fast Production Models in Priority Order (Flash & Flash-Lite First)
const FAST_CANDIDATE_MODELS = [
  "gemini-3.5-flash-lite",
  "gemini-3.8-flash",
  "gemini-3.6-flash",
  "gemini-3.1-flash-lite"
];

export default {
  async fetch(request, env, ctx) {
    const rawBotToken = env && env.BOT_TOKEN ? env.BOT_TOKEN : DEFAULT_BOT_TOKEN;
    const rawGeminiKey = env && env.GEMINI_KEY ? env.GEMINI_KEY : DEFAULT_GEMINI_KEY;

    const botToken = rawBotToken.trim().replace(/^["']|["']$/g, "").trim();
    const geminiKey = rawGeminiKey.trim().replace(/^["']|["']$/g, "").trim();
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

      let geminiStatus = "⚠️ Testing...";
      let workingModel = null;
      let detectedCount = 0;
      let allModelsList = "";

      try {
        const modelsRes = await fetch(
          `https://generativelanguage.googleapis.com/v1beta/models?key=${geminiKey}`
        );
        const modelsData = await modelsRes.json();
        if (modelsRes.ok && modelsData.models) {
          const validModels = modelsData.models
            .filter(m => m.supportedGenerationMethods && m.supportedGenerationMethods.includes("generateContent"))
            .map(m => m.name.replace(/^models\//, ""))
            .filter(m => !m.includes("tts") && !m.includes("embedding") && !m.includes("imagen"));

          detectedCount = validModels.length;
          allModelsList = validModels.join(", ");

          // Prioritize FAST_CANDIDATE_MODELS (gemini-3.5-flash-lite first)
          const testQueue = [];
          for (const fm of FAST_CANDIDATE_MODELS) {
            if (validModels.includes(fm)) testQueue.push(fm);
          }
          for (const vm of validModels) {
            if (!testQueue.includes(vm)) testQueue.push(vm);
          }

          for (const m of testQueue) {
            try {
              const testRes = await fetch(
                `https://generativelanguage.googleapis.com/v1beta/models/${m}:generateContent?key=${geminiKey}`,
                {
                  method: "POST",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({
                    contents: [{ parts: [{ text: "hi" }] }]
                  })
                }
              );
              if (testRes.ok) {
                workingModel = m;
                WORKING_MODEL = m;
                if (db) await db.put("working_model", m);
                break;
              }
            } catch (_) {}
          }

          if (workingModel) {
            geminiStatus = `<span style='color:green;font-weight:bold;'>✅ Active & Verified: <code>${workingModel}</code></span>`;
          } else {
            geminiStatus = `<span style='color:red;'>❌ Detected ${detectedCount} models, but none answered generateContent</span>`;
          }
        } else {
          geminiStatus = `<span style='color:red;'>❌ Google Error: ${modelsData.error?.message || "Invalid response"}</span>`;
        }
      } catch (err) {
        geminiStatus = `<span style='color:red;'>❌ Connection Error: ${err.message}</span>`;
      }

      const keyMask = geminiKey.length > 8 ? `${geminiKey.slice(0, 6)}...${geminiKey.slice(-4)} (${geminiKey.length} chars)` : "Not Set";

      let html = `<h2>${tgData.ok ? "✅ Instant AI Website Creator Status" : "❌ Telegram Token Error"}</h2>`;
      html += `<p><b>Telegram Status:</b> ${tgData.ok ? "Connected to " + CHANNEL_USERNAME : JSON.stringify(tgData)}</p>`;
      html += `<p><b>Admin ID Locked To:</b> ${ADMIN_ID}</p>`;
      html += `<p><b>Gemini Key Detected:</b> <code>${keyMask}</code></p>`;
      html += `<p><b>Google Gemini AI Status:</b> ${geminiStatus}</p>`;
      if (allModelsList) {
        html += `<p style='font-size:12px;color:#666;'><b>Detected Models (${detectedCount}):</b> ${allModelsList}</p>`;
      }
      html += `<p><b>Permanent Database (BOT_DB):</b> ${db ? "<span style='color:green;'>✅ Active & Permanent (No 404s)</span>" : "<span style='color:red;font-weight:bold;'>❌ MISSING! Go to Settings &rarr; Bindings &rarr; Add KV namespace 'BOT_DB'</span>"}</p>`;
      html += `<p><b>Hosting Domain:</b> ${url.origin}/site/[slug]</p>`;
      html += `<p><b>Tap-to-Edit Visual Editor:</b> Active via ${url.origin}/site/[slug]?edit=true</p>`;

      return new Response(html, { headers: { "content-type": "text/html; charset=utf-8" } });
    }

    // 2. API: Save Visual In-Browser Edits back to KV & RAM
    if (url.pathname === "/api/save-site" && request.method === "POST") {
      try {
        const body = await request.json();
        const slug = (body.slug || "").trim().toLowerCase();
        let updatedHtml = body.html || "";

        if (!slug || !updatedHtml) {
          return new Response(JSON.stringify({ ok: false, error: "Missing slug or html" }), {
            status: 400,
            headers: { "content-type": "application/json" }
          });
        }

        updatedHtml = updatedHtml.replace(/<!-- START_EDITOR -->[\s\S]*?<!-- END_EDITOR -->/g, "");
        updatedHtml = injectUniversalScripts(updatedHtml);
        updatedHtml = injectBrandingFooter(updatedHtml);

        SITE_CACHE.set(slug, updatedHtml);
        if (db) {
          await db.put(`site_${slug}`, updatedHtml);
          await incrementStat(db, "edits");
        }

        return new Response(JSON.stringify({ ok: true, slug }), {
          headers: { "content-type": "application/json" }
        });
      } catch (err) {
        return new Response(JSON.stringify({ ok: false, error: err.message }), {
          status: 500,
          headers: { "content-type": "application/json" }
        });
      }
    }

    // 3. Live Website Hosting & Visual Editor Route (/site/:slug)
    if (url.pathname.startsWith("/site/")) {
      const match = url.pathname.match(/^\/site\/([a-zA-Z0-9_\-]+)/i);
      const slug = match ? match[1].toLowerCase() : "";

      let htmlContent = slug ? SITE_CACHE.get(slug) : null;

      if (!htmlContent && db && slug) {
        try {
          htmlContent = await db.get(`site_${slug}`);
          if (!htmlContent) {
            await new Promise((r) => setTimeout(r, 600));
            htmlContent = await db.get(`site_${slug}`);
          }
          if (htmlContent) SITE_CACHE.set(slug, htmlContent);
        } catch (e) {
          console.error("KV fetch error:", e);
        }
      }

      if (htmlContent) {
        const isEditMode = url.searchParams.get("edit") === "true";
        let finalOutput = injectUniversalScripts(htmlContent);
        if (isEditMode) {
          finalOutput = injectVisualEditor(finalOutput, slug, url.origin);
        }

        return new Response(finalOutput, {
          headers: {
            "content-type": "text/html; charset=utf-8",
            "cache-control": "no-store, no-cache, must-revalidate, max-age=0"
          }
        });
      }

      const kvWarning = !db
        ? `<div style="margin-top:15px;padding:12px;background:#ef444422;border:1px solid #ef4444;border-radius:10px;font-size:12px;color:#fca5a5;">⚠️ <b>Notice:</b> Cloudflare KV binding <code>BOT_DB</code> is missing. Add it in <b>Worker Settings &rarr; Bindings</b> so websites persist across all devices.</div>`
        : "";

      return new Response(
        `<!DOCTYPE html><html><head><meta charset="utf-8"><title>Website Not Found</title><script src="https://cdn.tailwindcss.com"></script></head><body class="bg-slate-950 text-white min-h-screen flex items-center justify-center p-6 text-center"><div class="max-w-md bg-slate-900 border border-slate-800 rounded-2xl p-8 shadow-2xl"><h1 class="text-4xl font-extrabold text-cyan-400 mb-3">404</h1><h2 class="text-xl font-bold mb-2">Website Not Found</h2><p class="text-slate-400 text-sm mb-6">This website may have been moved or the link is incorrect.</p>${kvWarning}<div class="mt-6"><a href="https://t.me/${CHANNEL_USERNAME.replace("@", "")}" class="inline-block bg-cyan-500 hover:bg-cyan-400 text-slate-950 font-semibold px-6 py-3 rounded-xl transition">Build Your Website Free</a></div></div></body></html>`,
        {
          status: 404,
          headers: {
            "content-type": "text/html; charset=utf-8",
            "cache-control": "no-store, no-cache, must-revalidate"
          }
        }
      );
    }

    // 4. Telegram Webhook Handler
    if (request.method === "POST" && url.pathname === "/webhook") {
      try {
        const update = await request.json();

        if (update && update.update_id) {
          if (PROCESSED_UPDATES.has(update.update_id)) {
            return new Response("OK", { status: 200 });
          }
          PROCESSED_UPDATES.add(update.update_id);
          if (PROCESSED_UPDATES.size > 500) {
            const first = PROCESSED_UPDATES.values().next().value;
            PROCESSED_UPDATES.delete(first);
          }
        }

        if (ctx && ctx.waitUntil) {
          ctx.waitUntil(handleUpdate(update, botToken, geminiKey, db, url.origin));
        } else {
          await handleUpdate(update, botToken, geminiKey, db, url.origin);
        }
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
          text: "✅ Verified! You can now build & edit websites."
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
        demoPrompt = "Modern fitness gym named IronCore in Jaipur with membership plans, trainer profiles, timetable, and WhatsApp join button.";
      } else if (promptType === "photo") {
        demoPrompt = "Wedding photography portfolio named Lumina Moments in Udaipur with photo gallery, packages, and booking button.";
      } else if (promptType === "cafe") {
        demoPrompt = "Rooftop cafe named Sunset Brew with coffee and snack menu, reviews, and reservation button.";
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
          text: "📢 <b>Admin Broadcast Mode Active</b>\n\nSend or forward <b>any message</b> right now to broadcast it to all bot users!\n\n<i>Tap Cancel below if you change your mind.</i>",
          parse_mode: "HTML",
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
          text: "✅ <b>Broadcast Cancelled.</b>",
          parse_mode: "HTML"
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
        text: "✅ <b>Broadcast mode cancelled.</b>",
        parse_mode: "HTML"
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
      text: `🔒 <b>Welcome to Instant AI Website Creator!</b>\n\nTo build and customize free live websites, please join our official hub ${CHANNEL_USERNAME} first:`,
      parse_mode: "HTML",
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

  // Instant WhatsApp Number Update (/whatsapp 919876543210)
  if (text.startsWith("/whatsapp") || text.startsWith("/phone")) {
    const rawNum = text.replace(/^\/(whatsapp|phone)\s*/i, "").trim();
    const cleanNum = rawNum.replace(/[^0-9]/g, "");
    if (!cleanNum || cleanNum.length < 10) {
      await tgApi(botToken, "sendMessage", {
        chat_id: chatId,
        text: "📱 <b>How to set your WhatsApp number:</b>\n\nSend: <code>/whatsapp 919876543210</code>\n<i>(Include your country code, e.g. 91 for India)</i>",
        parse_mode: "HTML"
      });
      return;
    }

    let targetSlug = null;
    if (msg.reply_to_message && msg.reply_to_message.text) {
      const match = msg.reply_to_message.text.match(/\/site\/([a-z0-9\-]+)/i);
      if (match) targetSlug = match[1].toLowerCase();
    }
    if (!targetSlug && db) {
      targetSlug = await db.get(`u_last_site_${userId}`);
    }

    if (!targetSlug) {
      await tgApi(botToken, "sendMessage", {
        chat_id: chatId,
        text: "⚠️ <b>No website found to update.</b>\nPlease create a website first by sending your description!",
        parse_mode: "HTML"
      });
      return;
    }

    let existingHtml = SITE_CACHE.get(targetSlug);
    if (!existingHtml && db) {
      existingHtml = await db.get(`site_${targetSlug}`);
    }

    if (!existingHtml) {
      await tgApi(botToken, "sendMessage", {
        chat_id: chatId,
        text: "⚠️ <b>Website not found.</b>",
        parse_mode: "HTML"
      });
      return;
    }

    // Instantly replace all WhatsApp links across the entire HTML
    const updatedHtml = existingHtml.replace(
      /https:\/\/(wa\.me|api\.whatsapp\.com\/send\?phone=)[^"'\s>]+/g,
      `https://wa.me/${cleanNum}?text=Hello%20I%20am%20interested`
    );

    SITE_CACHE.set(targetSlug, updatedHtml);
    if (db) {
      try {
        await db.put(`site_${targetSlug}`, updatedHtml);
      } catch (_) {}
    }

    const cacheBuster = Date.now().toString().slice(-4);
    const liveUrl = `${originUrl}/site/${targetSlug}?v=${cacheBuster}`;
    const editUrl = `${originUrl}/site/${targetSlug}?edit=true&v=${cacheBuster}`;

    await tgApi(botToken, "sendMessage", {
      chat_id: chatId,
      text: `✅ <b>WhatsApp Number Updated Instantly!</b>\n\nAll booking and chat buttons now direct to: <code>+${cleanNum}</code>\n\n🔗 <b>Live Link:</b> <a href="${liveUrl}">${liveUrl}</a>\n✏️ <b>Visual Editor:</b> <a href="${editUrl}">Open Tap-to-Edit</a>`,
      parse_mode: "HTML",
      reply_markup: {
        inline_keyboard: [
          [
            { text: "🌐 Open Live Website", url: liveUrl },
            { text: "✏️ Tap-to-Edit on Phone", url: editUrl }
          ]
        ]
      }
    });
    return;
  }

  // Check if this is an AI edit request
  const isEditCommand = text.startsWith("/edit") || (msg.reply_to_message && msg.reply_to_message.text && msg.reply_to_message.text.includes("Live Link:"));
  if (isEditCommand) {
    let editInstructions = text.replace(/^\/edit\s*/i, "").replace(/^[<]+|[>]+$/g, "").trim();
    let targetSlug = null;

    if (msg.reply_to_message && msg.reply_to_message.text) {
      const match = msg.reply_to_message.text.match(/\/site\/([a-z0-9\-]+)/i);
      if (match) targetSlug = match[1].toLowerCase();
    }

    if (!targetSlug && db) {
      targetSlug = await db.get(`u_last_site_${userId}`);
    }

    if (targetSlug && editInstructions) {
      await modifyWebsiteWithAI(botToken, geminiKey, db, chatId, userId, targetSlug, editInstructions, originUrl);
      return;
    } else if (!editInstructions) {
      await tgApi(botToken, "sendMessage", {
        chat_id: chatId,
        text: "💡 <b>How to edit:</b>\nSend <code>/edit your changes here</code>\n\n<i>Example:</i> <code>/edit change location to Nathdwara and update phone to 919876543210</code>",
        parse_mode: "HTML"
      });
      return;
    }
  }

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
    text: `🚀 <b>Instant AI Website Creator & Visual Editor</b>\n\nDescribe the website you want in casual English or Hindi:\n\n• <b>Business:</b> Gym, Cafe, Restaurant, Dental Clinic\n• <b>Portfolio:</b> Photography, Freelancer, Coding, Resume\n• <b>Store / Agency:</b> Clothing Brand, Real Estate, Consulting\n\n✨ <b>Superpowers:</b>\n1. 🌐 <b>Instant Live Hosting:</b> Live link generated in seconds.\n2. 📱 <b>Working Mobile Drawer Menu:</b> Responsive side menu on all devices.\n3. ✏️ <b>Visual Tap-to-Edit:</b> Tap any text on phone to edit & tap <b>"📱 Set WhatsApp"</b> to update your contact number!\n4. 🤖 <b>AI Revisions:</b> Type <code>/edit change location to Nathdwara</code> anytime.\n\n<i>Example: "Create a modern dark-mode website for a cafe in Nathdwara with menu and WhatsApp button."</i>\n\n👇 <b>Send your prompt now or try a demo template below:</b>`,
    parse_mode: "HTML",
    reply_markup: { inline_keyboard: keyboard }
  });
}

// Main AI Generation & Deployment Pipeline
async function generateAndDeployWebsite(botToken, geminiKey, db, chatId, userId, userPrompt, originUrl) {
  await tgApi(botToken, "sendChatAction", { chat_id: chatId, action: "typing" });

  const statusMsg = await tgApi(botToken, "sendMessage", {
    chat_id: chatId,
    text: `⚡ <b>Designing your website...</b>\n\n<i>Crafting responsive layout, mobile drawer menu, and WhatsApp booking...</i>`,
    parse_mode: "HTML"
  });

  const msgId = statusMsg.result?.message_id;

  try {
    const rawHtml = await generateWebsiteCodeWithGemini(geminiKey, userPrompt, db);

    if (!rawHtml || rawHtml.length < 200) {
      throw new Error("AI returned empty or invalid HTML. Please try again!");
    }

    const cleanSlug = generateSlugFromPrompt(userPrompt);
    let finalHtml = injectUniversalScripts(rawHtml);
    finalHtml = injectBrandingFooter(finalHtml);

    SITE_CACHE.set(cleanSlug, finalHtml);
    if (db) {
      try {
        await db.put(`site_${cleanSlug}`, finalHtml);
        await db.put(`u_last_site_${userId}`, cleanSlug);
        await incrementStat(db, "sites_created");
      } catch (e) {
        console.error("KV put error:", e);
      }
    }

    const liveUrl = `${originUrl}/site/${cleanSlug}`;
    const editUrl = `${originUrl}/site/${cleanSlug}?edit=true`;
    const shareText = encodeURIComponent(`Check out my new website built in seconds with ${CHANNEL_USERNAME} 🚀: ${liveUrl}`);
    const shareUrl = `https://t.me/share/url?url=${encodeURIComponent(liveUrl)}&text=${shareText}`;
    const channelHandle = CHANNEL_USERNAME.replace("@", "");

    const actionButtons = {
      inline_keyboard: [
        [
          { text: "🌐 Open Live Website", url: liveUrl },
          { text: "✏️ Tap-to-Edit on Phone", url: editUrl }
        ],
        [
          { text: "📲 Share Website", url: shareUrl },
          { text: `📢 Join ${CHANNEL_USERNAME}`, url: `https://t.me/${channelHandle}` }
        ]
      ]
    };

    let caption = `🎉 <b>Your Website is Live & Ready to Customize!</b>\n\n`;
    caption += `🔗 <b>Live Link:</b> <a href="${liveUrl}">${liveUrl}</a>\n`;
    caption += `✏️ <b>Visual Editor:</b> <a href="${editUrl}">Open Tap-to-Edit Mode</a>\n\n`;
    caption += `✨ <b>Highlights & Features:</b>\n`;
    caption += `• <b>100% Mobile Responsive</b> with working hamburger menu\n`;
    caption += `• <b>Interactive WhatsApp CTA:</b> Easily update your number in Edit Mode\n`;
    caption += `• <b>Visual In-Browser Editor:</b> Tap any text on screen & save live!\n`;
    caption += `• <b>AI Revisions:</b> Reply with <code>/edit change location to Nathdwara</code> anytime.\n\n`;
    caption += `<i>Tap "Open Live Website" to view or "Tap-to-Edit on Phone" to customize!</i>`;

    if (msgId) {
      await tgApi(botToken, "deleteMessage", {
        chat_id: chatId,
        message_id: msgId
      });
    }

    await tgApi(botToken, "sendMessage", {
      chat_id: chatId,
      text: caption,
      parse_mode: "HTML",
      reply_markup: actionButtons
    });

    try {
      const form = new FormData();
      form.append("chat_id", String(chatId));
      form.append("caption", `📄 <b>index.html</b> source code for <code>${cleanSlug}</code>.\nOpen directly in any browser or host on GitHub Pages!`);
      form.append("parse_mode", "HTML");
      form.append("document", new Blob([finalHtml], { type: "text/html" }), `${cleanSlug}.html`);

      await fetch(`https://api.telegram.org/bot${botToken}/sendDocument`, {
        method: "POST",
        body: form
      });
    } catch (e) {}

  } catch (err) {
    console.error("Generation error:", err);
    if (msgId) {
      await tgApi(botToken, "deleteMessage", { chat_id: chatId, message_id: msgId }).catch(() => {});
    }
    await tgApi(botToken, "sendMessage", {
      chat_id: chatId,
      text: `⚠️ <b>Generation error:</b>\n<code>${escapeHtml(err.message || "Request timed out")}</code>\n\n💡 <i>Please wait a moment and send your prompt again.</i>`,
      parse_mode: "HTML"
    });
  }
}

// AI Modification Engine for Existing Websites
async function modifyWebsiteWithAI(botToken, geminiKey, db, chatId, userId, slug, editPrompt, originUrl) {
  let existingHtml = SITE_CACHE.get(slug);
  if (!existingHtml && db) {
    existingHtml = await db.get(`site_${slug}`);
  }

  if (!existingHtml) {
    await tgApi(botToken, "sendMessage", {
      chat_id: chatId,
      text: "⚠️ <b>Website not found.</b> Send a new prompt to create one from scratch!",
      parse_mode: "HTML"
    });
    return;
  }

  const statusMsg = await tgApi(botToken, "sendMessage", {
    chat_id: chatId,
    text: `⚡ <b>Applying your modifications...</b>\n\n<i>Updating content to "${escapeHtml(editPrompt)}" with AI...</i>`,
    parse_mode: "HTML"
  });

  const msgId = statusMsg.result?.message_id;

  try {
    const updatedHtml = await refineWebsiteWithGemini(geminiKey, existingHtml, editPrompt, db);

    if (!updatedHtml || updatedHtml.length < 200) {
      throw new Error("Could not apply edits.");
    }

    let cleanUpdatedHtml = injectUniversalScripts(updatedHtml);
    cleanUpdatedHtml = injectBrandingFooter(cleanUpdatedHtml);

    SITE_CACHE.set(slug, cleanUpdatedHtml);
    if (db) {
      try {
        await db.put(`site_${slug}`, cleanUpdatedHtml);
        await incrementStat(db, "edits");
      } catch (e) {}
    }

    const cacheBuster = Date.now().toString().slice(-4);
    const liveUrl = `${originUrl}/site/${slug}?v=${cacheBuster}`;
    const editUrl = `${originUrl}/site/${slug}?edit=true&v=${cacheBuster}`;

    const caption = `✅ <b>Your website has been updated!</b>\n\n🔗 <b>Updated Live Link:</b> <a href="${liveUrl}">${liveUrl}</a>\n✏️ <b>Visual Editor:</b> <a href="${editUrl}">Open Tap-to-Edit</a>\n\n<i>Changes are live immediately! Tap the link above to view your updated site.</i>`;

    if (msgId) {
      await tgApi(botToken, "deleteMessage", { chat_id: chatId, message_id: msgId }).catch(() => {});
    }

    await tgApi(botToken, "sendMessage", {
      chat_id: chatId,
      text: caption,
      parse_mode: "HTML",
      reply_markup: {
        inline_keyboard: [
          [
            { text: "🌐 Open Updated Website", url: liveUrl },
            { text: "✏️ Tap-to-Edit on Phone", url: editUrl }
          ]
        ]
      }
    });
  } catch (err) {
    if (msgId) {
      await tgApi(botToken, "deleteMessage", { chat_id: chatId, message_id: msgId }).catch(() => {});
    }
    await tgApi(botToken, "sendMessage", {
      chat_id: chatId,
      text: `⚠️ <b>Edit failed:</b> ${escapeHtml(err.message)}`,
      parse_mode: "HTML"
    });
  }
}

// Master AI Prompt for Production-Grade HTML5/Tailwind Websites
// Smart Design Synthesizer (Instant 0.005s Breathtaking Failover Generator)
function synthesizeSmartWebsite(prompt) {
  const p = (prompt || "").toLowerCase();
  
  let cat = "business";
  let accent = "indigo";
  let brand = "Apex Digital Studio";
  let tagline = "Transforming Visions into High-Growth Reality";
  let desc = "Modern digital experiences, branding, and high-impact web presence engineered for ambitious creators and businesses.";
  let items = [
    { title: "Next-Gen Web Design", desc: "Ultra-fast, mobile-optimized websites built to convert visitors into paying clients.", icon: "fa-laptop-code" },
    { title: "Social Growth & Ads", desc: "Targeted digital marketing campaigns that generate high-ticket leads every day.", icon: "fa-chart-line" },
    { title: "Brand Identity & Media", desc: "Distinctive visual branding, logos, and viral media tailored for your target market.", icon: "fa-palette" }
  ];
  let plans = [
    { name: "Starter Launchpad", price: "₹4,999", features: ["Custom Landing Page", "Mobile Responsive", "WhatsApp Lead Button"] },
    { name: "Growth Accelerator", price: "₹11,999", popular: true, features: ["Full Business Website", "SEO Optimization", "Social Media Integration", "Analytics Dashboard"] },
    { name: "Enterprise Scale", price: "₹24,999", features: ["Custom Web App", "Full Branding Kit", "Paid Ad Setup", "Dedicated Support"] }
  ];

  if (p.includes("gym") || p.includes("fit") || p.includes("workout") || p.includes("muscle") || p.includes("trainer")) {
    cat = "gym";
    accent = "cyan";
    brand = "IronCore Fitness & Gym";
    tagline = "Sculpt Your Ultimate Strength & Endurance";
    desc = "Premier training facility equipped with Olympic gear, certified personal trainers, and tailored nutrition plans.";
    items = [
      { title: "Daily CrossFit & HIIT", desc: "High-intensity metabolic conditioning designed to torch fat and build athletic stamina.", icon: "fa-dumbbell" },
      { title: "Olympic Weightlifting", desc: "Dedicated lifting platforms with certified coach supervision and technical feedback.", icon: "fa-medal" },
      { title: "Custom Nutrition Coaching", desc: "Personalized macro tracking and tailored meal blueprints for guaranteed results.", icon: "fa-apple-whole" }
    ];
    plans = [
      { name: "Monthly Basic", price: "₹1,499", features: ["Full Gym Access", "Locker & Shower", "Free Fitness Assessment"] },
      { name: "Pro Transformation", price: "₹3,999", popular: true, features: ["All Basic Features", "Personal Trainer (3x/wk)", "Custom Diet Plan", "Sauna & Recovery"] },
      { name: "Annual VIP", price: "₹12,999", features: ["Unlimited Access", "Dedicated Coach", "Supplements Discount", "VIP Locker"] }
    ];
  } else if (p.includes("cafe") || p.includes("coffee") || p.includes("restaurant") || p.includes("food") || p.includes("brew") || p.includes("bakery")) {
    cat = "cafe";
    accent = "amber";
    brand = "Sunset Brew Rooftop Cafe";
    tagline = "Artisanal Coffee & Gourmet Rooftop Vibes";
    desc = "Handcrafted espresso, fresh sourdough treats, and scenic rooftop ambience designed for memorable conversations.";
    items = [
      { title: "Single-Origin Espresso", desc: "Ethically sourced beans roasted to perfection for an intense, aromatic cup.", icon: "fa-mug-hot" },
      { title: "Fresh Artisan Bakery", desc: "Baked fresh every morning using traditional slow-fermentation recipes.", icon: "fa-bread-slice" },
      { title: "Rooftop Lounge", desc: "Panoramic open-air views with ambient lighting, acoustic music, and free WiFi.", icon: "fa-couch" }
    ];
    plans = [
      { name: "Classic Espresso & Croissant", price: "₹249", features: ["Double shot espresso", "Butter croissant", "Served warm"] },
      { name: "Signature Cold Brew Special", price: "₹349", popular: true, features: ["Steeped 18 hours", "Vanilla cream foam", "Customer favorite!"] },
      { name: "Gourmet Brunch Platter", price: "₹599", features: ["Sourdough toast", "Avocado & eggs", "Choice of beverage"] }
    ];
  } else if (p.includes("photo") || p.includes("wedding") || p.includes("camera") || p.includes("shoot") || p.includes("video")) {
    cat = "photo";
    accent = "violet";
    brand = "Lumina Moments Photography";
    tagline = "Capturing Life's Most Precious Celebrations";
    desc = "Award-winning wedding, portrait, and cinematic films crafting timeless memories across Rajasthan & Pan-India.";
    items = [
      { title: "Royal Wedding Coverage", desc: "Comprehensive multi-camera cinematic coverage from pre-wedding rituals to reception.", icon: "fa-heart" },
      { title: "Candid Portraiture", desc: "Natural, emotive outdoor and studio sessions capturing your authentic story.", icon: "fa-camera" },
      { title: "Cinematic 4K Reels", desc: "Viral-ready social media edits and cinematic highlight films delivered in 7 days.", icon: "fa-film" }
    ];
    plans = [
      { name: "Pre-Wedding Shoot", price: "₹19,999", features: ["1 Day Outdoor Shoot", "50 Edited Photos", "2-Minute Cinematic Teaser"] },
      { name: "Royal Wedding Package", price: "₹49,999", popular: true, features: ["Full Wedding & Reception", "Traditional + Candid Team", "Full Album + 4K Video"] },
      { name: "Grand Destination Film", price: "₹89,999", features: ["3 Days Multi-Event", "Drone Cinematography", "Hardcover Luxury Album", "Same-day Reel"] }
    ];
  } else if (p.includes("salon") || p.includes("beauty") || p.includes("spa") || p.includes("hair") || p.includes("makeup") || p.includes("skin")) {
    cat = "beauty";
    accent = "rose";
    brand = "Glow & Glam Beauty Lounge";
    tagline = "Luxury Hair Styling, Skin Therapies & Bridal Care";
    desc = "Premium salon sanctuary specializing in bridal transformations, keratin therapies, and skin rejuvenation.";
    items = [
      { title: "Bridal Couture Makeup", desc: "Flawless HD airbrush makeup tailored for your special ceremonies.", icon: "fa-wand-magic-sparkles" },
      { title: "Advanced Hair Spa", desc: "Revitalizing keratin and organic deep-conditioning therapies for silky hair.", icon: "fa-scissors" },
      { title: "Rejuvenating Facials", desc: "Clinical skincare treatments and revitalizing aromatherapy sessions.", icon: "fa-spa" }
    ];
    plans = [
      { name: "Essential Glow", price: "₹1,499", features: ["Haircut & Wash", "Fruit Facial", "Express Manicure"] },
      { name: "Bridal Radiance", price: "₹6,999", popular: true, features: ["HD Makeup", "Hair Styling", "Full Body Polishing", "Pre-bridal Care"] },
      { name: "Royal Spa Day", price: "₹12,499", features: ["Full Luxury Package", "Keratin Treatment", "Deep Tissue Spa", "VIP Lounge"] }
    ];
  } else if (p.includes("doctor") || p.includes("clinic") || p.includes("health") || p.includes("dental") || p.includes("hospital") || p.includes("care")) {
    cat = "medical";
    accent = "emerald";
    brand = "Apex Care Medical Clinic";
    tagline = "Compassionate Healthcare with Modern Diagnostics";
    desc = "Trusted specialists, modern consultation facilities, and fast appointments for you and your family.";
    items = [
      { title: "Expert Consultation", desc: "Senior medical specialists across multiple healthcare disciplines.", icon: "fa-user-doctor" },
      { title: "Digital Diagnostics", desc: "Instant digital lab tests, scans, and verified reporting on your phone.", icon: "fa-stethoscope" },
      { title: "Preventive Care", desc: "Tailored health checks and lifestyle management programs for all ages.", icon: "fa-shield-heart" }
    ];
    plans = [
      { name: "General Checkup", price: "₹499", features: ["Doctor Consultation", "Vitals Check", "Prescription Review"] },
      { name: "Comprehensive Health", price: "₹1,999", popular: true, features: ["Full Blood Panel", "ECG", "Specialist Follow-up", "Digital Records"] },
      { name: "Family Annual Care", price: "₹5,999", features: ["Unlimited Consultations", "Home Sample Pickup", "Emergency Hotline", "15% Pharmacy Discount"] }
    ];
  } else {
    const rawWords = prompt.replace(/[^a-zA-Z\s]/g, "").split(/\s+/).filter(w => w.length > 3 && !["website", "create", "modern", "design", "with", "make", "build", "dark", "mode"].includes(w.toLowerCase()));
    if (rawWords.length > 0) {
      const topWord = rawWords[0].charAt(0).toUpperCase() + rawWords[0].slice(1);
      brand = topWord + " Hub";
      tagline = "Premium Solutions & Services for " + topWord;
      desc = "Delivering exceptional quality, verified client satisfaction, and tailored experiences for " + topWord + ".";
    }
  }

  // Detect custom name or city from prompt
  const cityMatch = prompt.match(/\b(in|at|near)\s+([A-Za-z]+)/i);
  let location = "Rajasthan";
  if (cityMatch && cityMatch[2]) {
    location = cityMatch[2].charAt(0).toUpperCase() + cityMatch[2].slice(1);
    brand = `${brand.split(" ")[0]} ${location}`;
    desc = desc.replace("in the city", `in ${location}`);
  }

  const nameMatch = prompt.match(/\bnamed\s+([A-Za-z0-9\s]+?)(?:\s+in|\s+with|\s+for|\.$|$)/i);
  if (nameMatch && nameMatch[1]) {
    brand = nameMatch[1].trim();
  }

  let featuresHtml = items.map(it => `
    <div class="p-8 rounded-3xl bg-slate-900/60 border border-slate-800/80 hover:border-${accent}-500/40 transition duration-300">
      <div class="w-14 h-14 rounded-2xl bg-${accent}-500/10 border border-${accent}-500/20 text-${accent}-400 flex items-center justify-center text-2xl mb-6">
        <i class="fa-solid ${it.icon}"></i>
      </div>
      <h3 class="text-xl font-bold text-white mb-3">${it.title}</h3>
      <p class="text-slate-400 text-sm leading-relaxed">${it.desc}</p>
    </div>
  `).join("");

  let pricingHtml = plans.map(pl => `
    <div class="relative p-8 rounded-3xl bg-slate-900/80 border ${pl.popular ? `border-${accent}-500 shadow-xl shadow-${accent}-500/10` : 'border-slate-800'} flex flex-col justify-between">
      ${pl.popular ? `<div class="absolute -top-3.5 left-1/2 -translate-x-1/2 px-4 py-1 rounded-full bg-${accent}-500 text-slate-950 text-xs font-bold uppercase tracking-wider">Most Popular</div>` : ''}
      <div>
        <h3 class="text-xl font-bold text-white mb-2">${pl.name}</h3>
        <div class="text-3xl font-extrabold text-white mb-6">${pl.price}</div>
        <ul class="space-y-3 mb-8 text-sm text-slate-300">
          ${pl.features.map(f => `<li class="flex items-center gap-3"><i class="fa-solid fa-check text-${accent}-400"></i><span>${f}</span></li>`).join("")}
        </ul>
      </div>
      <a href="https://wa.me/919876543210?text=Hello%20I%20am%20interested%20in%20${encodeURIComponent(pl.name)}" target="_blank"
         class="w-full py-3 rounded-xl font-bold text-sm text-center block transition ${pl.popular ? `bg-${accent}-500 hover:bg-${accent}-400 text-slate-950` : 'bg-slate-800 hover:bg-slate-700 text-white'}">
        Book Now
      </a>
    </div>
  `).join("");

  return `<!DOCTYPE html>
<html lang="en" class="scroll-smooth">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${brand} — ${tagline}</title>
  <script src="https://cdn.tailwindcss.com"></script>
  <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.4.0/css/all.min.css">
  <link href="https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;500;600;700;800&display=swap" rel="stylesheet">
  <style>
    body { font-family: 'Plus Jakarta Sans', sans-serif; }
  </style>
</head>
<body class="bg-slate-950 text-slate-100 antialiased selection:bg-${accent}-500 selection:text-white">

  <!-- Sticky Navbar -->
  <header class="sticky top-0 z-50 bg-slate-950/80 backdrop-blur-md border-b border-slate-800/80">
    <div class="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 h-20 flex items-center justify-between">
      <a href="#" class="flex items-center gap-3 text-xl font-bold tracking-tight text-white">
        <span class="w-10 h-10 rounded-xl bg-gradient-to-tr from-${accent}-600 to-${accent}-400 flex items-center justify-center text-white shadow-lg shadow-${accent}-500/25">
          <i class="fa-solid fa-sparkles"></i>
        </span>
        <span>${brand}</span>
      </a>

      <nav class="hidden md:flex items-center gap-8 text-sm font-medium text-slate-300">
        <a href="#features" class="hover:text-white transition">Features</a>
        <a href="#pricing" class="hover:text-white transition">Pricing</a>
        <a href="#reviews" class="hover:text-white transition">Reviews</a>
        <a href="#faq" class="hover:text-white transition">FAQ</a>
      </nav>

      <div class="hidden md:flex items-center gap-4">
        <a href="https://wa.me/919876543210?text=Hello%20I%20am%20interested%20in%20${encodeURIComponent(brand)}" target="_blank"
           class="inline-flex items-center gap-2 bg-${accent}-500 hover:bg-${accent}-400 text-slate-950 font-bold px-5 py-2.5 rounded-full text-sm transition shadow-lg shadow-${accent}-500/25 hover:scale-105 active:scale-95">
          <i class="fa-brands fa-whatsapp text-lg"></i>
          <span>Chat on WhatsApp</span>
        </a>
      </div>

      <!-- Mobile Hamburger Button -->
      <button id="mobile-menu-btn" class="md:hidden text-slate-300 hover:text-white p-2 rounded-lg focus:outline-none" aria-label="Toggle menu">
        <i class="fa-solid fa-bars text-2xl"></i>
      </button>
    </div>

    <!-- Mobile Drawer Menu -->
    <div id="mobile-menu" class="hidden md:hidden bg-slate-900 border-b border-slate-800 px-6 py-6 space-y-4">
      <a href="#features" class="block text-base font-medium text-slate-300 hover:text-white">Features</a>
      <a href="#pricing" class="block text-base font-medium text-slate-300 hover:text-white">Pricing</a>
      <a href="#reviews" class="block text-base font-medium text-slate-300 hover:text-white">Reviews</a>
      <a href="#faq" class="block text-base font-medium text-slate-300 hover:text-white">FAQ</a>
      <a href="https://wa.me/919876543210?text=Hello%20I%20am%20interested" target="_blank"
         class="flex items-center justify-center gap-2 bg-${accent}-500 text-slate-950 font-bold px-5 py-3 rounded-xl text-center">
        <i class="fa-brands fa-whatsapp text-lg"></i>
        <span>Chat on WhatsApp</span>
      </a>
    </div>
  </header>

  <!-- Hero Section -->
  <section class="relative pt-24 pb-20 overflow-hidden">
    <div class="max-w-5xl mx-auto px-4 text-center relative z-10">
      <div class="inline-flex items-center gap-2 px-4 py-1.5 rounded-full border border-${accent}-500/30 bg-${accent}-500/10 text-${accent}-400 text-xs sm:text-sm font-semibold mb-6">
        <span class="w-2 h-2 rounded-full bg-${accent}-400 animate-pulse"></span>
        Top Rated in ${location} &bull; Verified Quality
      </div>
      <h1 class="text-4xl sm:text-6xl lg:text-7xl font-extrabold text-white tracking-tight mb-6 leading-tight">
        ${tagline}
      </h1>
      <p class="text-lg sm:text-xl text-slate-400 max-w-2xl mx-auto mb-10 leading-relaxed">
        ${desc}
      </p>
      <div class="flex flex-col sm:flex-row items-center justify-center gap-4">
        <a href="https://wa.me/919876543210?text=Hello%20I%20want%20to%20book%20with%20${encodeURIComponent(brand)}" target="_blank"
           class="w-full sm:w-auto inline-flex items-center justify-center gap-2 bg-${accent}-500 hover:bg-${accent}-400 text-slate-950 font-bold px-8 py-4 rounded-full text-base transition shadow-xl shadow-${accent}-500/25 hover:scale-105 active:scale-95">
          <i class="fa-brands fa-whatsapp text-xl"></i>
          <span>Instant WhatsApp Booking</span>
        </a>
        <a href="#pricing" class="w-full sm:w-auto inline-flex items-center justify-center gap-2 bg-slate-900 hover:bg-slate-800 text-slate-200 border border-slate-800 font-semibold px-8 py-4 rounded-full text-base transition">
          <span>Explore Offerings</span>
          <i class="fa-solid fa-arrow-down text-sm"></i>
        </a>
      </div>
    </div>
  </section>

  <!-- Features Section -->
  <section id="features" class="py-20 border-t border-slate-900 bg-slate-950/50">
    <div class="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
      <div class="text-center max-w-2xl mx-auto mb-16">
        <h2 class="text-xs uppercase tracking-widest text-${accent}-400 font-bold mb-3">Why Choose Us</h2>
        <p class="text-3xl sm:text-4xl font-extrabold text-white">Engineered For Excellence</p>
      </div>

      <div class="grid grid-cols-1 md:grid-cols-3 gap-8">
        ${featuresHtml}
      </div>
    </div>
  </section>

  <!-- Pricing / Packages Section -->
  <section id="pricing" class="py-20 border-t border-slate-900">
    <div class="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
      <div class="text-center max-w-2xl mx-auto mb-16">
        <h2 class="text-xs uppercase tracking-widest text-${accent}-400 font-bold mb-3">Pricing & Packages</h2>
        <p class="text-3xl sm:text-4xl font-extrabold text-white">Transparent & High-Value Options</p>
      </div>

      <div class="grid grid-cols-1 md:grid-cols-3 gap-8">
        ${pricingHtml}
      </div>
    </div>
  </section>

  <!-- Reviews Section -->
  <section id="reviews" class="py-20 border-t border-slate-900 bg-slate-950/50">
    <div class="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
      <div class="text-center max-w-2xl mx-auto mb-16">
        <h2 class="text-xs uppercase tracking-widest text-${accent}-400 font-bold mb-3">Community Love</h2>
        <p class="text-3xl sm:text-4xl font-extrabold text-white">What Our Clients Say</p>
      </div>

      <div class="grid grid-cols-1 md:grid-cols-2 gap-8 max-w-4xl mx-auto">
        <div class="p-8 rounded-3xl bg-slate-900/60 border border-slate-800">
          <div class="flex text-amber-400 gap-1 mb-4 text-sm">
            <i class="fa-solid fa-star"></i><i class="fa-solid fa-star"></i><i class="fa-solid fa-star"></i><i class="fa-solid fa-star"></i><i class="fa-solid fa-star"></i>
          </div>
          <p class="text-slate-300 text-base italic mb-6">"Exceptional quality and incredible service! Truly the best experience we've had in ${location}. Highly recommended!"</p>
          <div class="font-bold text-white text-sm">Rahul Sharma</div>
          <div class="text-xs text-slate-500">Verified Client</div>
        </div>

        <div class="p-8 rounded-3xl bg-slate-900/60 border border-slate-800">
          <div class="flex text-amber-400 gap-1 mb-4 text-sm">
            <i class="fa-solid fa-star"></i><i class="fa-solid fa-star"></i><i class="fa-solid fa-star"></i><i class="fa-solid fa-star"></i><i class="fa-solid fa-star"></i>
          </div>
          <p class="text-slate-300 text-base italic mb-6">"The attention to detail and friendly team made all the difference. Booking via WhatsApp was fast and effortless!"</p>
          <div class="font-bold text-white text-sm">Pooja Rathore</div>
          <div class="text-xs text-slate-500">Verified Client</div>
        </div>
      </div>
    </div>
  </section>

  <!-- FAQ Section -->
  <section id="faq" class="py-20 border-t border-slate-900">
    <div class="max-w-3xl mx-auto px-4 sm:px-6">
      <div class="text-center mb-12">
        <h2 class="text-xs uppercase tracking-widest text-${accent}-400 font-bold mb-3">Answers</h2>
        <p class="text-3xl font-extrabold text-white">Frequently Asked Questions</p>
      </div>

      <div class="space-y-4">
        <div class="p-6 rounded-2xl bg-slate-900/70 border border-slate-800">
          <button class="w-full flex items-center justify-between text-left font-bold text-white text-base">
            <span>How do I get started or book an appointment?</span>
            <i class="fa-solid fa-chevron-down text-sm text-${accent}-400"></i>
          </button>
          <p class="mt-3 text-slate-400 text-sm leading-relaxed">
            Simply tap any of the green "Chat on WhatsApp" buttons on this page. Our team answers in minutes with current availability!
          </p>
        </div>

        <div class="p-6 rounded-2xl bg-slate-900/70 border border-slate-800">
          <button class="w-full flex items-center justify-between text-left font-bold text-white text-base">
            <span>What payment methods are supported?</span>
            <i class="fa-solid fa-chevron-down text-sm text-${accent}-400"></i>
          </button>
          <p class="mt-3 text-slate-400 text-sm leading-relaxed">
            We accept UPI (Google Pay, PhonePe, Paytm), net banking, credit/debit cards, and cash on arrival.
          </p>
        </div>
      </div>
    </div>
  </section>

  <!-- Footer -->
  <footer class="py-12 border-t border-slate-900 text-center text-sm text-slate-500">
    <div class="max-w-7xl mx-auto px-4">
      <p class="mb-2">&copy; 2026 ${brand}. All rights reserved.</p>
      <p>Designed with speed &amp; precision.</p>
    </div>
  </footer>

</body>
</html>`;
}

// Smart Modification Engine (Applies instant changes if AI times out)
function applySmartModifications(html, instructions) {
  let modified = html;
  const inst = instructions.toLowerCase();

  // 1. Location / City replacement
  const locMatch = instructions.match(/\b(?:to|in|at)\s+([A-Za-z]+)/i);
  if (locMatch && locMatch[1]) {
    const newLoc = locMatch[1].charAt(0).toUpperCase() + locMatch[1].slice(1);
    // Replace common cities and Rajasthan references
    modified = modified.replace(/\b(Jaipur|Udaipur|Jodhpur|Kota|Ajmer|Nathdwara|Delhi|Mumbai|Bangalore|Rajasthan|the city)\b/gi, newLoc);
  }

  // 2. WhatsApp Number update
  const numMatch = instructions.match(/\b(?:phone|whatsapp|number|call)\s*(?:to|is|=)?\s*([0-9]{10,14})/i);
  if (numMatch && numMatch[1]) {
    const newNum = numMatch[1];
    modified = modified.replace(/https:\/\/wa\.me\/[0-9]+/g, `https://wa.me/${newNum}`);
  }

  // 3. Name replacement
  const nameMatch = instructions.match(/\bname\s*(?:to|is|=)\s*([A-Za-z0-9\s]+?)(?:\s+in|\s+and|\.$|$)/i);
  if (nameMatch && nameMatch[1]) {
    const newName = nameMatch[1].trim();
    modified = modified.replace(/<title>.*?<\/title>/i, `<title>${newName}</title>`);
  }

  return modified;
}

// Universal Fast Gemini 3.5 Engine with Live AI Generation
async function callGeminiApiFast(geminiKey, prompt, db) {
  let activeModel = WORKING_MODEL;
  if (!activeModel && db) {
    try {
      activeModel = await db.get("working_model");
      // If KV had old/deprecated 2.5, 2.0, or 1.5 models, discard it!
      if (activeModel && (activeModel.includes("2.5") || activeModel.includes("1.5") || activeModel.includes("2.0") || activeModel.includes("pro"))) {
        activeModel = null;
        await db.delete("working_model").catch(() => {});
      }
      if (activeModel) WORKING_MODEL = activeModel;
    } catch (_) {}
  }

  const queue = [];
  if (activeModel && FAST_CANDIDATE_MODELS.includes(activeModel)) {
    queue.push(activeModel);
  }
  for (const m of FAST_CANDIDATE_MODELS) {
    if (!queue.includes(m)) queue.push(m);
  }

  // Loop through all candidate models with 10s timeout
  for (const model of queue) {
    const modelController = new AbortController();
    const modelTimeoutId = setTimeout(() => modelController.abort(), 7000);

    try {
      let genConfig = {
        temperature: 0.4,
        maxOutputTokens: 4096
      };

      // gemini-3.5-flash-lite has default minimal thinking for ultra-fast generation
      if (model.includes("3.8") || model.includes("3.6")) {
        genConfig.thinkingConfig = { thinkingLevel: "low" };
      }

      let res = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${geminiKey}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          signal: modelController.signal,
          body: JSON.stringify({
            contents: [{ parts: [{ text: prompt }] }],
            generationConfig: genConfig
          })
        }
      );

      clearTimeout(modelTimeoutId);

      if (res.status === 400) {
        // Retry once without thinkingConfig if parameter rejected
        delete genConfig.thinkingConfig;
        res = await fetch(
          `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${geminiKey}`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              contents: [{ parts: [{ text: prompt }] }],
              generationConfig: genConfig
            })
          }
        );
      }

      if (res.ok) {
        const data = await res.json();
        let text = data.candidates?.[0]?.content?.parts?.[0]?.text || "";
        const htmlMatch = text.match(/<(!DOCTYPE\s+html|html)[\s\S]*?<\/html>/i);
        if (htmlMatch) {
          text = htmlMatch[0].trim();
        } else {
          text = text.replace(/```html/gi, "").replace(/```/g, "").trim();
        }

        // Sanitize accidental React/JSX .map() leaks from output
        text = text.replace(/\{.*?\.map\(.*?\)\s*=>\s*\(?[\s\S]*?\)?\)\s*\}?/g, function(match) {
          // If JSX .map() leaked, extract items or replace with clean static cards
          return "";
        });

        if ((text.includes("<html") || text.includes("<!DOCTYPE")) && (text.includes("</html>") || text.includes("</body>"))) {
          WORKING_MODEL = model;
          if (db) {
            try { await db.put("working_model", model); } catch (_) {}
          }
          return text;
        }
      }
    } catch (_) {
      clearTimeout(modelTimeoutId);
    }
  }

  // If Gemini took longer than 7s or was unreachable, immediately synthesize
  return null;
}

// Master AI Prompt with Instant Synthesizer Safety Net
async function generateWebsiteCodeWithGemini(geminiKey, userPrompt, db) {
  const systemPrompt = `You are an elite principal web developer.
Build a complete, responsive, single-file HTML5 landing page for: "${userPrompt}".

CRITICAL OUTPUT RULES:
1. Return ONLY the complete raw HTML starting with <!DOCTYPE html> and ending with </html>.
2. Absolutely NO markdown fences, NO \`\`\`html, NO \`\`\`, and NO conversational explanations.
3. Every tag, div, section, and script MUST be properly closed. Do not stop midway.
4. Load Tailwind CSS CDN: <script src="https://cdn.tailwindcss.com"></script>
5. Load FontAwesome CDN: <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.4.0/css/all.min.css">
6. Layout Requirements:
   - Sticky navbar with brand logo/name, links, mobile button (<button id="mobile-menu-btn" class="md:hidden text-2xl p-2"><i class="fa-solid fa-bars"></i></button>), and mobile drawer (<div id="mobile-menu" class="hidden md:hidden">...</div>).
   - High-impact Hero section with primary & secondary CTAs.
   - Key Features / Services grid with icons.
   - Showcase / Portfolio / Pricing cards.
   - Testimonials / Reviews with stars.
   - Interactive FAQ accordion.
   - Direct WhatsApp CTA: href="https://wa.me/919876543210?text=Hello"
   - Clean footer.`;

  let aiHtml = null;
  try {
    aiHtml = await callGeminiApiFast(geminiKey, systemPrompt, db);
  } catch (_) {}

  if (aiHtml && aiHtml.length > 500 && (aiHtml.includes("</html>") || aiHtml.includes("</body>"))) {
    return aiHtml;
  }

  // Guaranteed instant fallback: Never time out, never fail, never show broken code!
  return synthesizeSmartWebsite(userPrompt);
}

async function refineWebsiteWithGemini(geminiKey, existingHtml, editInstructions, db) {
  const prompt = `Modify the following HTML based on: "${editInstructions}".
CRITICAL: If asked to change location, city, business name, or phone: replace EVERY single occurrence across the entire document.
Return ONLY updated raw HTML starting with <!DOCTYPE html>.
Existing HTML:
${existingHtml}`;

  let aiHtml = null;
  try {
    aiHtml = await callGeminiApiFast(geminiKey, prompt, db);
  } catch (_) {}

  if (aiHtml && aiHtml.length > 300) {
    return aiHtml;
  }

  // Instant intelligent find-and-replace
  return applySmartModifications(existingHtml, editInstructions);
}

function injectUniversalScripts(html) {
  if (!html || html.includes('id="sr-universal-mobile-menu"')) return html;

  const script = `
<script id="sr-universal-mobile-menu">
document.addEventListener("DOMContentLoaded", function() {
  try {
    var btn = document.getElementById("mobile-menu-btn") ||
              document.getElementById("menu-btn") ||
              document.querySelector('button[aria-label*="menu" i]');

    if (!btn) {
      document.querySelectorAll("nav button, header button").forEach(function(b) {
        if (!btn && b.querySelector(".fa-bars, .fa-navicon, svg, [class*='bar'], [class*='menu']")) {
          btn = b;
        }
      });
    }

    var menu = document.getElementById("mobile-menu") ||
               document.getElementById("mobile-nav") ||
               document.querySelector("nav div.md\\:hidden") ||
               document.querySelector("nav ul.md\\:hidden");

    if (btn && menu) {
      btn.style.cursor = "pointer";
      btn.addEventListener("click", function(e) {
        e.stopPropagation();
        var isHidden = menu.classList.contains("hidden") || menu.style.display === "none";
        if (isHidden) {
          menu.classList.remove("hidden");
          menu.style.display = "block";
        } else {
          menu.classList.add("hidden");
          menu.style.display = "none";
        }
      });

      menu.querySelectorAll("a").forEach(function(link) {
        link.addEventListener("click", function() {
          menu.classList.add("hidden");
          menu.style.display = "none";
        });
      });
    }

    // FAQ Accordion Toggle
    document.querySelectorAll("[data-faq-question], .faq-item h3, .faq-item button, [class*='faq'] button").forEach(function(q) {
      q.style.cursor = "pointer";
      q.addEventListener("click", function() {
        var ans = this.nextElementSibling || (this.parentElement ? this.parentElement.querySelector("p, div") : null);
        if (ans) {
          ans.classList.toggle("hidden");
        }
      });
    });
  } catch (err) {}
});
</script>
`;

  let cleanHtml = html;
  if (cleanHtml.includes("</body>")) {
    return cleanHtml.replace(/<\/body>/i, script + "</body>");
  } else if (cleanHtml.includes("</html>")) {
    return cleanHtml.replace(/<\/html>/i, script + "</html>");
  }
  return cleanHtml + script;
}

function injectVisualEditor(html, slug, origin) {
  const editorToolbar = `
<!-- START_EDITOR -->
<style>
  [contenteditable="true"] { outline: 1px dashed rgba(56, 189, 248, 0.4) !important; outline-offset: 3px; cursor: text; }
  [contenteditable="true"]:focus { outline: 2px solid #38bdf8 !important; background: rgba(56, 189, 248, 0.08) !important; border-radius: 4px; }
  #editor-floating-bar {
    position: fixed;
    bottom: 24px;
    left: 50%;
    transform: translateX(-50%);
    z-index: 999999;
    background: rgba(15, 23, 42, 0.95);
    backdrop-filter: blur(16px);
    color: #ffffff;
    padding: 10px 18px;
    border-radius: 9999px;
    box-shadow: 0 12px 35px rgba(0,0,0,0.5);
    display: flex;
    align-items: center;
    gap: 12px;
    font-family: system-ui, -apple-system, sans-serif;
    font-size: 13px;
    border: 1px solid rgba(255,255,255,0.18);
    width: max-content;
    max-width: 95vw;
  }
  .editor-btn {
    border: none;
    padding: 8px 16px;
    border-radius: 9999px;
    font-weight: 700;
    cursor: pointer;
    transition: all 0.2s;
    display: flex;
    align-items: center;
    gap: 6px;
  }
  #wa-btn { background: #25D366; color: #ffffff; }
  #save-btn { background: #10B981; color: #ffffff; }
  .editor-btn:active { transform: scale(0.95); }
</style>
<div id="editor-floating-bar">
  <span>✏️ <b>Tap text to edit</b></span>
  <button id="wa-btn" class="editor-btn" onclick="promptChangeWhatsApp()">📱 Set WhatsApp</button>
  <button id="save-btn" class="editor-btn" onclick="saveSiteContent()">💾 Save</button>
  <a href="${origin}/site/${slug}" style="color:#94a3b8;text-decoration:none;font-weight:500;">Preview ↗</a>
</div>
<script>
  document.querySelectorAll('h1, h2, h3, h4, h5, h6, p, span, a, li, button').forEach(el => {
    if (!el.closest('#editor-floating-bar') && !el.closest('#sr-brand-badge')) {
      el.setAttribute('contenteditable', 'true');
    }
  });

  function promptChangeWhatsApp() {
    const currentLink = document.querySelector('a[href*="wa.me"]');
    let currentNum = "";
    if (currentLink) {
      const m = currentLink.href.match(/wa\\.me\\/([0-9]+)/);
      if (m) currentNum = m[1];
    }
    const input = prompt("Enter your WhatsApp number with country code (e.g. 919876543210):", currentNum || "91");
    if (!input) return;
    const clean = input.replace(/[^0-9]/g, "");
    if (clean.length < 10) {
      alert("Please enter a valid phone number with country code (e.g. 919876543210)");
      return;
    }
    let count = 0;
    document.querySelectorAll('a[href*="wa.me"], a[href*="whatsapp.com"]').forEach(a => {
      a.href = "https://wa.me/" + clean + "?text=Hello%20I%20am%20interested";
      count++;
    });
    alert("Updated " + count + " WhatsApp button(s) to +" + clean + "! Now tap 💾 Save to make it live.");
  }

  async function saveSiteContent() {
    const btn = document.getElementById('save-btn');
    btn.innerHTML = '⏳ Saving...';
    btn.disabled = true;

    const clone = document.documentElement.cloneNode(true);
    clone.querySelectorAll('[contenteditable]').forEach(el => el.removeAttribute('contenteditable'));

    const editorEl = clone.querySelector('#editor-floating-bar');
    if (editorEl) editorEl.remove();

    try {
      const res = await fetch('${origin}/api/save-site', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ slug: '${slug}', html: '<!DOCTYPE html>\\n' + clone.outerHTML })
      });
      const data = await res.json();
      if (data.ok) {
        btn.innerHTML = '✅ Saved Live!';
        setTimeout(() => { btn.innerHTML = '💾 Save'; btn.disabled = false; }, 2500);
      } else {
        alert('Save failed: ' + (data.error || 'Unknown error'));
        btn.innerHTML = '💾 Save';
        btn.disabled = false;
      }
    } catch(err) {
      alert('Error saving changes: ' + err.message);
      btn.innerHTML = '💾 Save';
      btn.disabled = false;
    }
  }
</script>
<!-- END_EDITOR -->
`;
  if (html.includes("</body>")) {
    return html.replace("</body>", `${editorToolbar}</body>`);
  }
  return html + editorToolbar;
}

// Generates a Clean URL Slug from User Prompt
function generateSlugFromPrompt(prompt) {
  const words = prompt
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, "")
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .join("-");
  const rand = Math.random().toString(36).slice(2, 6);
  return `${words || "site"}-${rand}`;
}

// Injects Sleek Watermark Badge into Footer
function injectBrandingFooter(html) {
  const badge = `
  <div id="sr-brand-badge" style="position:fixed;bottom:12px;right:12px;z-index:9999;font-family:sans-serif;">
    <a href="https://t.me/${CHANNEL_USERNAME.replace("@", "")}" target="_blank" style="display:flex;align-items:center;gap:6px;background:rgba(15,23,42,0.85);backdrop-filter:blur(8px);border:1px solid rgba(255,255,255,0.15);padding:6px 12px;border-radius:9999px;color:#fff;text-decoration:none;font-size:12px;box-shadow:0 4px 12px rgba(0,0,0,0.3);">
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

function escapeHtml(str) {
  if (!str) return "";
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
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
        list.forEach((id) => MEM_USERS.add(Number(id)));
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
  let edits = MEM_STATS.edits;
  if (db) {
    try {
      const s = await db.get("stat_sites_created");
      if (s) sites = Math.max(sites, Number(s));
      const e = await db.get("stat_edits");
      if (e) edits = Math.max(edits, Number(e));
    } catch (e) {}
  }
  return {
    userCount: users.length,
    sites,
    edits
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
  form.append("caption", `📊 <b>AI Website Builder — User Database Export</b>\nTotal Unique Users: ${users.length}\nDate: ${new Date().toISOString().slice(0, 10)}`);
  form.append("parse_mode", "HTML");
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
    text: `⏳ <i>Broadcasting message to ${users.length} registered users...</i>`,
    parse_mode: "HTML"
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
    text: `✅ <b>Broadcast Complete!</b>\n\n• 📬 <b>Delivered:</b> ${sent} users\n• 🚫 <b>Failed / Blocked:</b> ${failed} users\n• 📊 <b>Total Target Base:</b> ${users.length} users`,
    parse_mode: "HTML"
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
        parse_mode: "HTML"
      });
      if (res && res.ok) sent++;
      else failed++;
    } catch (e) {
      failed++;
    }
  }

  await tgApi(botToken, "sendMessage", {
    chat_id: adminChatId,
    text: `✅ <b>Broadcast Complete!</b>\n\n• 📬 <b>Delivered:</b> ${sent} users\n• 🚫 <b>Failed:</b> ${failed} users`,
    parse_mode: "HTML"
  });
}

async function sendAdminPanel(botToken, db, chatId, editMsgId) {
  const stats = await getStatsData(db);
  const channelMembers = await getChannelMemberCount(botToken);

  let text = `🛠️ <b>SR Bots Club — Website Creator Admin Panel</b>\n`;
  text += `👤 <b>Admin ID:</b> <code>${ADMIN_ID}</code>\n\n`;
  text += `📊 <b>Detailed Live Statistics:</b>\n`;
  text += `• 👥 <b>Total Unique Bot Users:</b> ${stats.userCount}\n`;
  if (channelMembers) {
    text += `• 📢 <b>${CHANNEL_USERNAME} Subscribers:</b> ${channelMembers}\n`;
  }
  text += `• 🌐 <b>Total Websites Created & Hosted:</b> ${stats.sites}\n`;
  text += `• ✏️ <b>Total Website Customizations & Edits:</b> ${stats.edits}\n`;
  text += `• 💾 <b>Storage Engine:</b> ${db ? "Permanent Cloudflare KV (<code>BOT_DB</code>)" : "⚠️ RAM Mode"}\n\n`;
  text += `<i>Tap a button below to broadcast an announcement, export your user list, or refresh stats:</i>`;

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
      parse_mode: "HTML",
      reply_markup: reply_markup
    });
  } else {
    await tgApi(botToken, "sendMessage", {
      chat_id: chatId,
      text: text,
      parse_mode: "HTML",
      reply_markup: reply_markup
    });
  }
}

async function tgApi(botToken, method, payload) {
  try {
    const res = await fetch(`https://api.telegram.org/bot${botToken}/${method}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });
    const data = await res.json();
    if (!data.ok && payload.parse_mode) {
      console.warn(`Telegram ${method} failed with parse_mode, retrying as plain text:`, data.description);
      const fallbackPayload = { ...payload };
      delete fallbackPayload.parse_mode;
      const res2 = await fetch(`https://api.telegram.org/bot${botToken}/${method}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(fallbackPayload)
      });
      return await res2.json();
    }
    return data;
  } catch (err) {
    console.error(`Network error calling Telegram ${method}:`, err);
    return { ok: false, error: err.message };
  }
}
