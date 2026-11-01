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

          for (const m of validModels) {
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
async function generateWebsiteCodeWithGemini(geminiKey, userPrompt, db) {
  const systemPrompt = `You are an elite principal web designer and frontend architect.
The user wants a website described as: "${userPrompt}".

Create a single, complete, production-ready, beautiful, mobile-first HTML5 file.

Requirements:
1. Load Tailwind CSS via CDN: <script src="https://cdn.tailwindcss.com"></script>
2. Load FontAwesome 6 Icons: <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.4.0/css/all.min.css">
3. Choose a sleek, modern palette (e.g. slate-950/cyan for tech/gym, warm stone/amber for cafes, indigo/gold for luxury).
4. Include rich realistic sections:
   - Modern Sticky Navbar: brand name, desktop links, mobile hamburger button (<button id="mobile-menu-btn" class="md:hidden"><i class="fa-solid fa-bars"></i></button>), and mobile drawer (<div id="mobile-menu" class="hidden md:hidden">...links...</div>).
   - Hero Section with bold typography, badges, and primary/secondary CTA buttons
   - Features / Services Grid with high-contrast cards
   - Pricing or Menu or Showcase Cards with realistic items and highlights
   - Testimonials / Social Proof with star ratings
   - Interactive FAQ Section with vanilla JS toggle
   - Direct WhatsApp / Contact button: href="https://wa.me/919876543210?text=Hello%20I%20am%20interested"
   - Polished Footer
5. Make it concise and clean. Return ONLY valid raw HTML code without markdown code fences, no backticks, no conversational commentary.`;

  const model = await getWorkingModel(geminiKey, db);

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 25000);

  try {
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${geminiKey}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: controller.signal,
        body: JSON.stringify({
          contents: [{ parts: [{ text: systemPrompt }] }],
          generationConfig: {
            temperature: 0.3,
            maxOutputTokens: 4096
          }
        })
      }
    );

    clearTimeout(timeoutId);

    if (!res.ok) {
      const errJson = await res.json().catch(() => ({}));
      throw new Error(errJson.error?.message || `HTTP ${res.status} (${model})`);
    }

    const data = await res.json();
    let text = data.candidates?.[0]?.content?.parts?.[0]?.text || "";
    text = text.replace(/^```html\s*/i, "").replace(/```\s*$/i, "").trim();
    if (text.includes("<html") || text.includes("<!DOCTYPE")) {
      return text;
    }
  } catch (e) {
    clearTimeout(timeoutId);
    throw new Error(e.name === "AbortError" ? "AI generation timed out after 25s" : e.message);
  }

  throw new Error("Could not generate valid HTML");
}

// AI Modification Prompt
async function refineWebsiteWithGemini(geminiKey, existingHtml, editInstructions, db) {
  const prompt = `You are an elite web developer.
Modify the following existing website HTML based on this user instruction: "${editInstructions}".

Strict Editing Instructions:
1. Carefully apply all content and location updates requested by the user. For example, if asked to change location, city, business name, phone number, or prices: find and replace ALL occurrences throughout the entire page (navbar, hero headline, description, address, map placeholder, testimonials, contact section, footer).
2. Retain the existing layout structure, Tailwind CSS styling, FontAwesome icons, and scripts unless specifically asked to change them.
3. Return ONLY the complete, updated raw HTML code starting with <!DOCTYPE html> and ending with </html>.
4. No markdown fences, no backticks, no explanatory comments.

Existing HTML Code:
${existingHtml}`;

  const model = await getWorkingModel(geminiKey, db);

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 25000);

  try {
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${geminiKey}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: controller.signal,
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: {
            temperature: 0.2,
            maxOutputTokens: 4096
          }
        })
      }
    );

    clearTimeout(timeoutId);

    if (!res.ok) {
      const errJson = await res.json().catch(() => ({}));
      throw new Error(errJson.error?.message || `HTTP ${res.status} (${model})`);
    }

    const data = await res.json();
    let text = data.candidates?.[0]?.content?.parts?.[0]?.text || "";
    text = text.replace(/^```html\s*/i, "").replace(/```\s*$/i, "").trim();
    if (text.includes("<html") || text.includes("<!DOCTYPE")) {
      return text;
    }
  } catch (e) {
    clearTimeout(timeoutId);
    throw new Error(e.name === "AbortError" ? "AI modification timed out after 25s" : e.message);
  }

  throw new Error("Could not modify website");
}

// Fast retrieval of verified working model from RAM or KV
async function getWorkingModel(geminiKey, db) {
  if (WORKING_MODEL) return WORKING_MODEL;

  if (db) {
    try {
      const stored = await db.get("working_model");
      if (stored) {
        WORKING_MODEL = stored;
        return stored;
      }
    } catch (_) {}
  }

  try {
    const modelsRes = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${geminiKey}`);
    const data = await modelsRes.json();
    if (data.models) {
      const valid = data.models
        .filter(m => m.supportedGenerationMethods && m.supportedGenerationMethods.includes("generateContent"))
        .map(m => m.name.replace(/^models\//, ""))
        .filter(m => !m.includes("tts") && !m.includes("embedding") && !m.includes("imagen"));

      for (const m of valid) {
        try {
          const test = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${m}:generateContent?key=${geminiKey}`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ contents: [{ parts: [{ text: "hi" }] }] })
          });
          if (test.ok) {
            WORKING_MODEL = m;
            if (db) await db.put("working_model", m);
            return m;
          }
        } catch (_) {}
      }
    }
  } catch (_) {}

  return "gemini-2.0-flash";
}

// Injects Universal Mobile Drawer Menu & Accordion Helper
function injectUniversalScripts(html) {
  if (html.includes("id=\"sr-universal-mobile-menu\"")) return html;

  const script = `
<script id="sr-universal-mobile-menu">
(function() {
  function initMobileMenu() {
    const btn = document.getElementById('mobile-menu-btn') ||
                document.getElementById('menu-btn') ||
                document.querySelector('nav button:has(.fa-bars)') ||
                document.querySelector('nav button:has(svg)');

    const menu = document.getElementById('mobile-menu') ||
                 document.getElementById('mobile-nav') ||
                 document.querySelector('nav div.md\\:hidden') ||
                 document.querySelector('nav ul.md\\:hidden');

    if (btn && menu) {
      btn.style.cursor = 'pointer';
      btn.addEventListener('click', function(e) {
        e.stopPropagation();
        if (menu.classList.contains('hidden')) {
          menu.classList.remove('hidden');
          menu.style.display = 'block';
        } else {
          menu.classList.add('hidden');
          menu.style.display = 'none';
        }
      });

      menu.querySelectorAll('a').forEach(link => {
        link.addEventListener('click', function() {
          menu.classList.add('hidden');
          menu.style.display = 'none';
        });
      });
    }

    // Interactive FAQ Accordions
    document.querySelectorAll('[data-faq-question], .faq-item h3, .faq-item button').forEach(q => {
      q.style.cursor = 'pointer';
      q.addEventListener('click', function() {
        const answer = this.nextElementSibling || this.parentElement.querySelector('p');
        if (answer) {
          answer.classList.toggle('hidden');
        }
      });
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initMobileMenu);
  } else {
    initMobileMenu();
  }
})();
</script>
`;
  if (html.includes("</body>")) {
    return html.replace("</body>", `${script}</body>`);
  }
  return html + script;
}

// Injects Mobile-Friendly Visual Tap-to-Edit Mode & Floating Action Bar
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
