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

export default {
  async fetch(request, env, ctx) {
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

        // Clean out injected editor toolbar so saved site is 100% clean
        updatedHtml = updatedHtml.replace(/<!-- START_EDITOR -->[\s\S]*?<!-- END_EDITOR -->/g, "");

        // Ensure branding footer stays present
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
      const slug = url.pathname.replace("/site/", "").trim().toLowerCase();
      let htmlContent = SITE_CACHE.get(slug);

      if (!htmlContent && db) {
        try {
          htmlContent = await db.get(`site_${slug}`);
          if (htmlContent) SITE_CACHE.set(slug, htmlContent);
        } catch (e) {}
      }

      if (htmlContent) {
        const isEditMode = url.searchParams.get("edit") === "true";
        const finalOutput = isEditMode ? injectVisualEditor(htmlContent, slug, url.origin) : htmlContent;

        return new Response(finalOutput, {
          headers: {
            "content-type": "text/html; charset=utf-8",
            "cache-control": isEditMode ? "no-store, no-cache" : "public, max-age=1800"
          }
        });
      }

      return new Response(
        `<!DOCTYPE html><html><head><meta charset="utf-8"><title>Website Not Found</title><script src="https://cdn.tailwindcss.com"></script></head><body class="bg-slate-950 text-white min-h-screen flex items-center justify-center p-6 text-center"><div class="max-w-md bg-slate-900 border border-slate-800 rounded-2xl p-8 shadow-2xl"><h1 class="text-4xl font-extrabold text-cyan-400 mb-3">404</h1><h2 class="text-xl font-bold mb-2">Website Not Found</h2><p class="text-slate-400 text-sm mb-6">This website may have been moved or the link is incorrect.</p><a href="https://t.me/${CHANNEL_USERNAME.replace("@", "")}" class="inline-block bg-cyan-500 hover:bg-cyan-400 text-slate-950 font-semibold px-6 py-3 rounded-xl transition">Build Your Website Free</a></div></body></html>`,
        { status: 404, headers: { "content-type": "text/html; charset=utf-8" } }
      );
    }

    // 4. Telegram Webhook Handler (Immediate 200 OK + Background Execution)
    if (request.method === "POST" && url.pathname === "/webhook") {
      try {
        const update = await request.json();

        // Deduplication to prevent double-clicks & retries
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

        // Return 200 OK to Telegram immediately so it NEVER retries or duplicates
        if (ctx && ctx.waitUntil) {
          ctx.waitUntil(handleUpdate(update, botToken, geminiKey, db, url.origin));
        } else {
          handleUpdate(update, botToken, geminiKey, db, url.origin).catch(console.error);
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
      text: `🔒 *Welcome to Instant AI Website Creator!*\n\nTo build and customize free live websites, please join our official hub ${CHANNEL_USERNAME} first:`,
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

  // Check if this is an AI edit request for user's previous website
  const isEditCommand = text.startsWith("/edit ") || (msg.reply_to_message && msg.reply_to_message.text && msg.reply_to_message.text.includes("Live Link:"));
  if (isEditCommand) {
    let editInstructions = text.replace(/^\/edit\s*/i, "").trim();
    let targetSlug = null;

    if (msg.reply_to_message && msg.reply_to_message.text) {
      const match = msg.reply_to_message.text.match(/\/site\/([a-z0-9\-]+)/i);
      if (match) targetSlug = match[1].toLowerCase();
    }

    if (!targetSlug && db) {
      targetSlug = await db.get(`u_last_site_${userId}`);
    }

    if (targetSlug) {
      await modifyWebsiteWithAI(botToken, geminiKey, db, chatId, userId, targetSlug, editInstructions, originUrl);
      return;
    }
  }

  // Generate and Deploy Live Website from Casual Prompt
  await generateAndDeployWebsite(botToken, geminiKey, db, chatId, userId, text, originUrl);
}

// Welcome Menu with Demo Templates & Feature Overview
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
    text: `🚀 *Instant AI Website Creator & Visual Editor*\n\nDescribe the website you want in casual English or Hindi:\n\n• *Business:* Gym, Cafe, Restaurant, Dental Clinic\n• *Portfolio:* Photography, Freelancer, Coding, Resume\n• *Store / Agency:* Clothing Brand, Real Estate, Consulting\n\n✨ *Key Features:*\n1. 🌐 *Instant Edge Hosting:* Live link deployed on Cloudflare.\n2. ✏️ *Visual Tap-to-Edit:* Tap any headline, price, or text on your phone to customize it, then save live in 1 tap!\n3. 🤖 *AI Revisions:* Reply to any site with changes or type \`/edit make it dark mode\`.\n\n_Example: "Create a modern dark-mode website for a sneaker store named KicksHub in Jaipur with product cards and WhatsApp order button."_\n\n👇 *Send your prompt now or try a demo template below:*`,
    parse_mode: "Markdown",
    reply_markup: { inline_keyboard: keyboard }
  });
}

// Main AI Generation & Deployment Pipeline with Realistic Progress Steps
async function generateAndDeployWebsite(botToken, geminiKey, db, chatId, userId, userPrompt, originUrl) {
  // 1. Initial Animated Progress Tracker Message
  const statusMsg = await tgApi(botToken, "sendMessage", {
    chat_id: chatId,
    text: `⚡ *Analyzing your prompt...*\n\`[▓░░░░░░░░░] 15%\` Designing layout & color palette...`,
    parse_mode: "Markdown"
  });

  const msgId = statusMsg.result?.message_id;

  try {
    // 2. Start Gemini Generation alongside Dynamic Visual Progress Steps
    const aiPromise = generateWebsiteCodeWithGemini(geminiKey, userPrompt);
    const rawHtml = await trackProgress(botToken, chatId, msgId, aiPromise);

    if (!rawHtml || rawHtml.length < 200) {
      throw new Error("AI returned empty or invalid HTML. Please try again!");
    }

    // 3. Mark 100% when HTML is received and being saved
    if (msgId) {
      await tgApi(botToken, "editMessageText", {
        chat_id: chatId,
        message_id: msgId,
        text: `🚀 *Deploying to Edge CDN...*\n\`[▓▓▓▓▓▓▓▓▓▓] 100%\` Finalizing Cloudflare hosting...`,
        parse_mode: "Markdown"
      });
    }

    // 4. Generate URL slug & embed watermark
    const cleanSlug = generateSlugFromPrompt(userPrompt);
    const finalHtml = injectBrandingFooter(rawHtml);

    // 5. Store permanently in KV database & RAM cache
    SITE_CACHE.set(cleanSlug, finalHtml);
    if (db) {
      try {
        await db.put(`site_${cleanSlug}`, finalHtml);
        await db.put(`u_last_site_${userId}`, cleanSlug);
        await incrementStat(db, "sites_created");
      } catch (e) {}
    }

    const liveUrl = `${originUrl}/site/${cleanSlug}`;
    const editUrl = `${originUrl}/site/${cleanSlug}?edit=true`;
    const shareText = encodeURIComponent(`Check out my new website built in 8 seconds with ${CHANNEL_USERNAME} 🚀: ${liveUrl}`);
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

    let caption = `🎉 *Your Website is Live & Ready to Customize!*\n\n`;
    caption += `🔗 *Live Link:* \`${liveUrl}\`\n`;
    caption += `✏️ *Visual Editor:* [Open Tap-to-Edit Mode](${editUrl})\n\n`;
    caption += `✨ *Highlights & Features:*\n`;
    caption += `• *100% Mobile Responsive* with Tailwind CSS\n`;
    caption += `• *Dynamic Visuals:* Floating gradients, hover lift & glass cards\n`;
    caption += `• *Interactive WhatsApp CTA:* Floating animated booking button\n`;
    caption += `• *Visual In-Browser Editor:* Tap any text or price on screen & save live!\n`;
    caption += `• *AI Revisions:* Reply to this message with \`/edit <changes>\` anytime.\n\n`;
    caption += `_Tap "Open Live Website" to view or "Tap-to-Edit on Phone" to customize text!_`;

    // 6. Smoothly transform the progress message directly into the finished delivery card
    if (msgId) {
      await tgApi(botToken, "editMessageText", {
        chat_id: chatId,
        message_id: msgId,
        text: caption,
        parse_mode: "Markdown",
        reply_markup: actionButtons
      });
    } else {
      await tgApi(botToken, "sendMessage", {
        chat_id: chatId,
        text: caption,
        parse_mode: "Markdown",
        reply_markup: actionButtons
      });
    }

    // 7. Send standalone index.html source code file
    try {
      const form = new FormData();
      form.append("chat_id", String(chatId));
      form.append("caption", `📄 *index.html* source code for \`${cleanSlug}\`.\nOpen directly in any browser or host on GitHub Pages!`);
      form.append("parse_mode", "Markdown");
      form.append("document", new Blob([finalHtml], { type: "text/html" }), `${cleanSlug}.html`);

      await fetch(`https://api.telegram.org/bot${botToken}/sendDocument`, {
        method: "POST",
        body: form
      });
    } catch (e) {}

  } catch (err) {
    console.error("Generation error:", err);
    if (msgId) {
      await tgApi(botToken, "editMessageText", {
        chat_id: chatId,
        message_id: msgId,
        text: `⚠️ *Website generation encountered an error:*\n\`${err.message || "Request timed out"}\`\n\nPlease tap a demo button or send your prompt again!`,
        parse_mode: "Markdown"
      });
    }
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
      text: "⚠️ *Website not found.* Send a new prompt to create one from scratch!",
      parse_mode: "Markdown"
    });
    return;
  }

  const statusMsg = await tgApi(botToken, "sendMessage", {
    chat_id: chatId,
    text: `⚡ *Applying your modifications...*\n\`[▓▓▓░░░░░░░] 30%\` Updating design & text with AI...`,
    parse_mode: "Markdown"
  });

  const msgId = statusMsg.result?.message_id;

  try {
    const aiPromise = refineWebsiteWithGemini(geminiKey, existingHtml, editPrompt);
    const updatedHtml = await trackProgress(botToken, chatId, msgId, aiPromise);

    if (!updatedHtml || updatedHtml.length < 200) {
      throw new Error("Could not apply edits.");
    }

    const cleanUpdatedHtml = injectBrandingFooter(updatedHtml);

    SITE_CACHE.set(slug, cleanUpdatedHtml);
    if (db) {
      try {
        await db.put(`site_${slug}`, cleanUpdatedHtml);
        await incrementStat(db, "edits");
      } catch (e) {}
    }

    const liveUrl = `${originUrl}/site/${slug}`;
    const editUrl = `${originUrl}/site/${slug}?edit=true`;

    const caption = `✅ *Your website has been updated!*\n\n🔗 *Updated Live Link:* \`${liveUrl}\`\n✏️ *Visual Editor:* [Open Tap-to-Edit](${editUrl})\n\n_Your changes are live immediately for all visitors!_`;

    if (msgId) {
      await tgApi(botToken, "editMessageText", {
        chat_id: chatId,
        message_id: msgId,
        text: caption,
        parse_mode: "Markdown",
        reply_markup: {
          inline_keyboard: [
            [
              { text: "🌐 Open Updated Website", url: liveUrl },
              { text: "✏️ Tap-to-Edit on Phone", url: editUrl }
            ]
          ]
        }
      });
    }
  } catch (err) {
    if (msgId) {
      await tgApi(botToken, "editMessageText", {
        chat_id: chatId,
        message_id: msgId,
        text: `⚠️ *Edit failed:* ${err.message}`,
        parse_mode: "Markdown"
      });
    }
  }
}

// Realistic Dynamic Progress Runner (Never reaches 100% until AI actually completes)
async function trackProgress(botToken, chatId, msgId, promise) {
  if (!msgId) return await promise;

  const steps = [
    { text: `🎨 *Building responsive layout...*\n\`[▓▓▓▓░░░░░░] 45%\` Styling Tailwind components & glass cards...`, ms: 2200 },
    { text: `📱 *Injecting dynamic visuals...*\n\`[▓▓▓▓▓▓▓░░░] 75%\` Adding hover transitions, pulsing CTA & icons...`, ms: 2800 },
    { text: `⚡ *Finalizing code architecture...*\n\`[▓▓▓▓▓▓▓▓▓░] 90%\` Optimizing mobile responsiveness...`, ms: 3200 }
  ];

  let completed = false;
  const runner = promise.then(res => { completed = true; return res; }).catch(err => { completed = true; throw err; });

  (async () => {
    for (const step of steps) {
      await new Promise(r => setTimeout(r, step.ms));
      if (completed) break;
      await tgApi(botToken, "editMessageText", {
        chat_id: chatId,
        message_id: msgId,
        text: step.text,
        parse_mode: "Markdown"
      });
    }
  })();

  return await runner;
}

// Master AI Prompt for Production-Grade HTML5/Tailwind Websites with Dynamic Visuals
async function generateWebsiteCodeWithGemini(geminiKey, userPrompt) {
  const systemPrompt = `You are an elite principal web designer and frontend architect.
The user wants a website described as: "${userPrompt}".

Create a single, complete, production-ready, beautiful, mobile-first HTML5 file.

Technical & Visual Requirements:
1. Load Tailwind CSS via CDN: <script src="https://cdn.tailwindcss.com"></script>
2. Load FontAwesome 6 Icons: <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.4.0/css/all.min.css">
3. Choose a sleek, modern palette (e.g. slate-950 with cyan/emerald highlights, warm stone with amber, or deep indigo with violet).
4. Dynamic Visual Elements:
   - Floating subtle ambient gradient spheres / mesh background effects (e.g. absolute blur-3xl opacity-20 blobs).
   - Glassmorphic card styling (bg-white/5 backdrop-blur-md border border-white/10).
   - Smooth hover transitions (hover:scale-[1.02] hover:shadow-2xl transition-all duration-300).
   - Pulsing fixed WhatsApp floating button at bottom-right (https://wa.me/919876543210?text=Hello%20I%20am%20interested).
   - Functional Vanilla JS for mobile navbar hamburger toggle & FAQ accordion collapse/expand.
5. Rich realistic sections:
   - Modern Sticky Navbar with logo, links, and "Get Started" CTA button.
   - High-impact Hero Section with bold typography, badges, and primary/secondary buttons.
   - Features / Services Grid with high-contrast icons.
   - Pricing or Menu or Showcase Cards (with realistic items, prices in ₹ / $, and highlights).
   - Testimonials / Social Proof with avatar badges and 5-star ratings.
   - Interactive FAQ Section with vanilla JS toggle.
   - Polished Footer.
6. Make it completely self-contained. Return ONLY valid raw HTML code without markdown code fences, no backticks, no conversational commentary.`;

  // Direct fast model order (no slow GET /models network overhead)
  const models = ["gemini-2.5-flash", "gemini-2.0-flash", "gemini-1.5-flash"];
  let lastError = null;

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
      if (!res.ok) {
        const errData = await res.json().catch(() => ({}));
        lastError = errData.error?.message || `HTTP ${res.status}`;
        continue;
      }
      const data = await res.json();
      let text = data.candidates?.[0]?.content?.parts?.[0]?.text || "";
      text = text.replace(/^```html\s*/i, "").replace(/```\s*$/i, "").trim();
      if (text.includes("<html") || text.includes("<!DOCTYPE")) {
        return text;
      }
    } catch (e) {
      lastError = e.message;
    }
  }
  throw new Error(lastError || "Could not generate valid HTML");
}

// AI Modification Prompt
async function refineWebsiteWithGemini(geminiKey, existingHtml, editInstructions) {
  const prompt = `You are an elite web developer.
Modify the following existing website HTML based on this user instruction: "${editInstructions}".

Strict Guidelines:
1. Retain the existing layout, Tailwind CSS, FontAwesome, and functionality unless specifically asked to change them.
2. Return ONLY the complete, updated raw HTML code starting with <!DOCTYPE html> and ending with </html>.
3. No markdown fences, no backticks, no explanatory comments.

Existing HTML Code:
${existingHtml}`;

  const models = ["gemini-2.5-flash", "gemini-2.0-flash", "gemini-1.5-flash"];
  let lastError = null;

  for (const model of models) {
    try {
      const res = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${geminiKey}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            contents: [{ parts: [{ text: prompt }] }],
            generationConfig: { temperature: 0.2 }
          })
        }
      );
      if (!res.ok) {
        const errData = await res.json().catch(() => ({}));
        lastError = errData.error?.message || `HTTP ${res.status}`;
        continue;
      }
      const data = await res.json();
      let text = data.candidates?.[0]?.content?.parts?.[0]?.text || "";
      text = text.replace(/^```html\s*/i, "").replace(/```\s*$/i, "").trim();
      if (text.includes("<html") || text.includes("<!DOCTYPE")) {
        return text;
      }
    } catch (e) {
      lastError = e.message;
    }
  }
  throw new Error(lastError || "Could not modify website");
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
    padding: 10px 20px;
    border-radius: 9999px;
    box-shadow: 0 12px 35px rgba(0,0,0,0.5);
    display: flex;
    align-items: center;
    gap: 14px;
    font-family: system-ui, -apple-system, sans-serif;
    font-size: 13px;
    border: 1px solid rgba(255,255,255,0.18);
    width: max-content;
    max-width: 92vw;
  }
  #save-btn {
    background: #10B981;
    color: #ffffff;
    border: none;
    padding: 8px 18px;
    border-radius: 9999px;
    font-weight: 700;
    cursor: pointer;
    transition: all 0.2s;
    display: flex;
    align-items: center;
    gap: 6px;
  }
  #save-btn:active { transform: scale(0.95); }
  #save-btn:disabled { opacity: 0.6; cursor: not-allowed; }
</style>
<div id="editor-floating-bar">
  <span>✏️ <b>Tap any text to edit</b></span>
  <button id="save-btn" onclick="saveSiteContent()">💾 Save Changes</button>
  <a href="${origin}/site/${slug}" style="color:#94a3b8;text-decoration:none;font-weight:500;">Preview Live ↗</a>
</div>
<script>
  // Enable inline editing on all text elements except editor bar & badges
  document.querySelectorAll('h1, h2, h3, h4, h5, h6, p, span, a, li, button').forEach(el => {
    if (!el.closest('#editor-floating-bar') && !el.closest('#sr-brand-badge')) {
      el.setAttribute('contenteditable', 'true');
    }
  });

  async function saveSiteContent() {
    const btn = document.getElementById('save-btn');
    btn.innerHTML = '⏳ Saving...';
    btn.disabled = true;

    // Clone and remove editable flags before saving
    const clone = document.documentElement.cloneNode(true);
    clone.querySelectorAll('[contenteditable]').forEach(el => el.removeAttribute('contenteditable'));

    // Strip editor bar from clone
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
        setTimeout(() => { btn.innerHTML = '💾 Save Changes'; btn.disabled = false; }, 2500);
      } else {
        alert('Save failed: ' + (data.error || 'Unknown error'));
        btn.innerHTML = '💾 Save Changes';
        btn.disabled = false;
      }
    } catch(err) {
      alert('Error saving changes: ' + err.message);
      btn.innerHTML = '💾 Save Changes';
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
    .slice(0, 3)
    .join("-");
  const rand = Math.random().toString(36).slice(2, 6);
  return `${words || "site"}-${rand}`;
}

// Injects Sleek Watermark Badge into Footer
function injectBrandingFooter(html) {
  const badge = `
  <div id="sr-brand-badge" style="position:fixed;bottom:12px;right:12px;z-index:9999;font-family:sans-serif;">
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
  text += `• ✏️ *Total Website Customizations & Edits:* ${stats.edits}\n`;
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
