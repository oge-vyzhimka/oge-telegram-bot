// Supabase Edge Function: 24/7 Telegram Bot for "Выжимка ОГЭ" & Remote PC Control
// Runs in Supabase Cloud on Deno (Zero cold-start, 24/7 online even when PC is off)

const TELEGRAM_BOT_TOKEN = Deno.env.get("TELEGRAM_BOT_TOKEN") || "";
const GITHUB_TOKEN = Deno.env.get("GITHUB_TOKEN") || "";
const GITHUB_REPO = Deno.env.get("GITHUB_REPO") || "oge-vyzhimka/vijimka-oge";
const ADMIN_SECRET = Deno.env.get("ADMIN_SECRET") || "vyzhimka2026";
const SUPABASE_URL = Deno.env.get("SUPABASE_URL") || "";
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";

// Strict Whitelist: Only these 3 usernames can access the bot
const ALLOWED_USERNAMES = new Set(["vakuq", "k1slyy", "nezovsky"]);

let runtimeGeminiKey = Deno.env.get("GEMINI_API_KEY") || "";
let runtimeSelectedModel = Deno.env.get("ACTIVE_AI_MODEL") || "auto";

// Database-backed PC Task Queue & Status
async function updatePcHeartbeat(info?: unknown) {
  try {
    if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) return;
    await fetch(`${SUPABASE_URL}/rest/v1/pc_status`, {
      method: "POST",
      headers: {
        "apikey": SUPABASE_SERVICE_ROLE_KEY,
        "Authorization": `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
        "Content-Type": "application/json",
        "Prefer": "resolution=merge-duplicates"
      },
      body: JSON.stringify({
        id: 1,
        is_online: true,
        last_seen: new Date().toISOString(),
        info: info || {}
      })
    });
  } catch (e) {
    console.error("updatePcHeartbeat error:", e);
  }
}

async function getPcOnlineStatus(): Promise<{ isOnline: boolean; info?: Record<string, unknown> }> {
  try {
    if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) return { isOnline: false };
    const res = await fetch(`${SUPABASE_URL}/rest/v1/pc_status?id=eq.1&select=last_seen,info`, {
      headers: {
        "apikey": SUPABASE_SERVICE_ROLE_KEY,
        "Authorization": `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`
      }
    });
    const rows = await res.json();
    if (Array.isArray(rows) && rows.length > 0) {
      const diff = Date.now() - new Date(rows[0].last_seen).getTime();
      return { isOnline: diff < 30000, info: rows[0].info };
    }
  } catch (e) {
    console.error("getPcOnlineStatus error:", e);
  }
  return { isOnline: false };
}

async function addPcTask(task: { chatId: number; username: string; type: string; instruction?: string; cmd?: string }) {
  try {
    if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) return;
    await fetch(`${SUPABASE_URL}/rest/v1/pc_tasks`, {
      method: "POST",
      headers: {
        "apikey": SUPABASE_SERVICE_ROLE_KEY,
        "Authorization": `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        command: task.type,
        payload: task,
        status: "pending"
      })
    });
  } catch (e) {
    console.error("addPcTask error:", e);
  }
}

async function popPcTask() {
  try {
    if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) return null;
    const res = await fetch(`${SUPABASE_URL}/rest/v1/pc_tasks?status=eq.pending&order=id.asc&limit=1`, {
      headers: {
        "apikey": SUPABASE_SERVICE_ROLE_KEY,
        "Authorization": `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`
      }
    });
    const rows = await res.json();
    if (Array.isArray(rows) && rows.length > 0) {
      const taskRow = rows[0];
      await fetch(`${SUPABASE_URL}/rest/v1/pc_tasks?id=eq.${taskRow.id}`, {
        method: "PATCH",
        headers: {
          "apikey": SUPABASE_SERVICE_ROLE_KEY,
          "Authorization": `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({ status: "processing" })
      });
      return { id: String(taskRow.id), ...taskRow.payload };
    }
  } catch (e) {
    console.error("popPcTask error:", e);
  }
  return null;
}

async function sendTelegram(chatId: number, text: string, parseMode: string = "HTML", replyMarkup?: unknown) {
  try {
    const payload: Record<string, unknown> = {
      chat_id: chatId,
      text,
      parse_mode: parseMode,
      disable_web_page_preview: false,
    };
    if (replyMarkup) {
      payload.reply_markup = replyMarkup;
    }
    const res = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    return await res.json();
  } catch (err) {
    console.error("Telegram send error:", err);
    return null;
  }
}

async function sendTelegramPhoto(chatId: number, base64Data: string, caption?: string) {
  try {
    const binary = atob(base64Data);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i);
    }
    const blob = new Blob([bytes], { type: "image/jpeg" });
    const formData = new FormData();
    formData.append("chat_id", String(chatId));
    formData.append("photo", blob, "screen.jpg");
    if (caption) {
      formData.append("caption", caption);
      formData.append("parse_mode", "HTML");
    }
    const res = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendPhoto`, {
      method: "POST",
      body: formData,
    });
    return await res.json();
  } catch (err) {
    console.error("sendPhoto error:", err);
    return null;
  }
}

async function answerCallbackQuery(callbackQueryId: string, text?: string) {
  try {
    await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/answerCallbackQuery`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ callback_query_id: callbackQueryId, text }),
    });
  } catch (_) {}
}

async function saveSecret(name: string, value: string) {
  const mgmtToken = Deno.env.get("MGMT_ACCESS_TOKEN");
  const projectRef = Deno.env.get("PROJECT_REF") || "rkzzfszozgleeujkxzlb";
  if (!mgmtToken) return false;
  try {
    const res = await fetch(`https://api.supabase.com/v1/projects/${projectRef}/secrets`, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${mgmtToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify([{ name, value }]),
    });
    return res.ok;
  } catch (e) {
    console.error("Save secret error:", e);
    return false;
  }
}

async function getGitHubCommit(repo: string) {
  try {
    const res = await fetch(`https://api.github.com/repos/${repo}/commits?per_page=1`, {
      headers: {
        "Authorization": `token ${GITHUB_TOKEN}`,
        "User-Agent": "VyjimkaBot",
      },
    });
    const commits = await res.json();
    if (Array.isArray(commits) && commits.length > 0) {
      const c = commits[0];
      return {
        sha: c.sha.substring(0, 7),
        message: c.commit.message,
        author: c.commit.author.name,
        date: new Date(c.commit.author.date).toLocaleString("ru-RU", { timeZone: "Europe/Moscow" }),
      };
    }
  } catch (err) {
    console.error("GitHub commit fetch error:", err);
  }
  return null;
}

async function getGitHubFile(repo: string, path: string, branch = "main") {
  try {
    const res = await fetch(`https://api.github.com/repos/${repo}/contents/${path}?ref=${branch}`, {
      headers: {
        "Authorization": `token ${GITHUB_TOKEN}`,
        "User-Agent": "VyjimkaBot",
      },
    });
    if (!res.ok) return null;
    const data = await res.json();
    const binary = atob(data.content.replace(/\s/g, ""));
    const bytes = Uint8Array.from(binary, (m) => m.charCodeAt(0));
    const content = new TextDecoder().decode(bytes);
    return { sha: data.sha, content };
  } catch (err) {
    console.error("GitHub file fetch error:", err);
    return null;
  }
}

async function putGitHubFile(repo: string, path: string, contentStr: string, commitMsg: string, sha?: string, branch = "main") {
  try {
    const bytes = new TextEncoder().encode(contentStr);
    let binary = "";
    for (let i = 0; i < bytes.length; i++) {
      binary += String.fromCharCode(bytes[i]);
    }
    const b64 = btoa(binary);

    const body: Record<string, unknown> = {
      message: commitMsg,
      content: b64,
      branch: branch,
    };
    if (sha) body.sha = sha;

    const res = await fetch(`https://api.github.com/repos/${repo}/contents/${path}`, {
      method: "PUT",
      headers: {
        "Authorization": `token ${GITHUB_TOKEN}`,
        "Content-Type": "application/json",
        "User-Agent": "VyjimkaBot",
      },
      body: JSON.stringify(body),
    });
    return await res.json();
  } catch (err) {
    console.error("GitHub file put error:", err);
    return null;
  }
}

async function triggerRedeploy(repo: string) {
  const path = ".github_deploy_trigger";
  const now = new Date().toISOString();
  const file = await getGitHubFile(repo, path);
  const res = await putGitHubFile(
    repo,
    path,
    `Last remote deploy trigger: ${now}\nTriggered via Telegram Bot 24/7 Cloud\n`,
    `[Bot 24/7] Re-deploy triggered at ${now}`,
    file?.sha
  );
  return res;
}

async function rollbackCommit(repo: string, branch = "main") {
  try {
    const res = await fetch(`https://api.github.com/repos/${repo}/commits?per_page=2`, {
      headers: { "Authorization": `token ${GITHUB_TOKEN}`, "User-Agent": "VyjimkaBot" }
    });
    const commits = await res.json();
    if (!Array.isArray(commits) || commits.length < 2) return null;
    const previousCommit = commits[1];

    const patchRes = await fetch(`https://api.github.com/repos/${repo}/git/refs/heads/${branch}`, {
      method: "PATCH",
      headers: {
        "Authorization": `token ${GITHUB_TOKEN}`,
        "Content-Type": "application/json",
        "User-Agent": "VyjimkaBot"
      },
      body: JSON.stringify({ sha: previousCommit.sha, force: true })
    });

    if (patchRes.ok) {
      return {
        revertedSha: commits[0].sha.substring(0, 7),
        revertedMsg: commits[0].commit.message,
        restoredSha: previousCommit.sha.substring(0, 7),
        restoredMsg: previousCommit.commit.message
      };
    }
  } catch (err) {
    console.error("Rollback error:", err);
  }
  return null;
}

async function checkSiteHealth() {
  try {
    const t0 = Date.now();
    const res = await fetch("https://oge-vyzhimka.github.io/vijimka-oge/", { method: "HEAD" });
    const ms = Date.now() - t0;
    return { status: res.status, ok: res.ok, ms };
  } catch (err) {
    return { status: 0, ok: false, ms: 0, error: String(err) };
  }
}

async function askAI(prompt: string, context: string, apiKey: string, preferredModel?: string): Promise<{ success: boolean; updatedCode?: string; error?: string; isAnswer?: boolean; message?: string }> {
  const systemInstruction = `Ты AI-разработчик сайта "Выжимка ОГЭ". Твоя задача — редактировать исходный код сайта (index.html) по поручению владельца.
Файл большой. НЕ переписывай весь файл целиком!
Найди конкретное место в коде, которое нужно изменить, и верни ТОЛЬКО валидный JSON (без markdown блоков \`\`\`) следующего формата:
{
  "search": "точный фрагмент из текущего кода, который нужно заменить (2-5 строк)",
  "replace": "новый фрагмент, который должен встать на его место"
}`;

  try {
    if (apiKey.startsWith("sk-or-")) {
      let candidateModels: string[] = ["qwen/qwen3.8-27b:free", "stealth/space-bunny-alpha", "nvidia/nemotron-3.5-lightning:free"];
      if (preferredModel && preferredModel !== "auto") {
        candidateModels = [preferredModel, ...candidateModels.filter((m) => m !== preferredModel)];
      }

      let lastError = "";
      for (const model of candidateModels.slice(0, 5)) {
        try {
          const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
            method: "POST",
            headers: {
              "Authorization": `Bearer ${apiKey}`,
              "Content-Type": "application/json",
              "HTTP-Referer": "https://oge-vyzhimka.github.io/vijimka-oge/",
              "X-Title": "VyjimkaBot",
            },
            body: JSON.stringify({
              model: model,
              messages: [
                { role: "system", content: systemInstruction },
                { role: "user", content: `ЗАДАЧА ПОЛЬЗОВАТЕЛЯ:\n${prompt}\n\nФРАГМЕНТЫ КОДА ДЛЯ СПРАВКИ:\n${context.substring(0, 15000)}` }
              ]
            })
          });

          const data = await res.json();
          if (!res.ok) {
            lastError = data?.error?.message || `HTTP ${res.status}`;
            continue;
          }

          const rawContent = data?.choices?.[0]?.message?.content?.trim();
          if (!rawContent) continue;

          const cleaned = rawContent.replace(/^```[a-z]*\n?/i, "").replace(/```$/i, "").trim();
          try {
            const parsed = JSON.parse(cleaned);
            if (parsed.search && parsed.replace !== undefined) {
              if (context.includes(parsed.search)) {
                return { success: true, updatedCode: context.replace(parsed.search, parsed.replace) };
              }
              const trimmedSearch = parsed.search.trim();
              if (context.includes(trimmedSearch)) {
                return { success: true, updatedCode: context.replace(trimmedSearch, parsed.replace.trim()) };
              }
            }
          } catch (_) {
            return { success: false, isAnswer: true, message: cleaned };
          }
        } catch (e) {
          lastError = String(e);
        }
      }
      return { success: false, error: lastError || "Модели OpenRouter временно недоступны." };
    }

    const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${apiKey}`;
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [
          {
            role: "user",
            parts: [{ text: `${systemInstruction}\n\nЗАДАЧА ПОЛЬЗОВАТЕЛЯ:\n${prompt}\n\nКОД:\n${context.substring(0, 25000)}` }]
          }
        ]
      })
    });
    const data = await res.json();
    if (!res.ok) {
      return { success: false, error: data?.error?.message || `Gemini Error ${res.status}` };
    }
    const answer = data?.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!answer) return { success: false, error: "Пустой ответ от Gemini." };
    const cleaned = answer.replace(/^```[a-z]*\n?/i, "").replace(/```$/i, "").trim();
    try {
      const parsed = JSON.parse(cleaned);
      if (parsed.search && parsed.replace !== undefined && context.includes(parsed.search.trim())) {
        return { success: true, updatedCode: context.replace(parsed.search.trim(), parsed.replace.trim()) };
      }
    } catch (_) {}
    return { success: false, error: "Не удалось сопоставить изменения в коде." };
  } catch (err) {
    return { success: false, error: String(err) };
  }
}

// Main Deno server handler
Deno.serve(async (req: Request) => {
  const url = new URL(req.url);

  // 1. Endpoints for Local PC Agent
  if (url.searchParams.get("agent_poll")) {
    const sec = url.searchParams.get("secret");
    if (sec !== ADMIN_SECRET) return new Response("Unauthorized", { status: 401 });
    await updatePcHeartbeat();
    const task = await popPcTask();
    return new Response(JSON.stringify({ ok: true, task, pcOnline: true }), {
      headers: { "Content-Type": "application/json" }
    });
  }

  if (url.searchParams.get("agent_heartbeat")) {
    const sec = url.searchParams.get("secret");
    if (sec !== ADMIN_SECRET) return new Response("Unauthorized", { status: 401 });
    try {
      const info = await req.json();
      await updatePcHeartbeat(info);
    } catch (_) {
      await updatePcHeartbeat();
    }
    return new Response(JSON.stringify({ ok: true }), { headers: { "Content-Type": "application/json" } });
  }

  if (url.searchParams.get("agent_result")) {
    const sec = url.searchParams.get("secret");
    if (sec !== ADMIN_SECRET) return new Response("Unauthorized", { status: 401 });
    try {
      const payload = await req.json();
      if (payload.chatId) {
        if (payload.photoBase64) {
          await sendTelegramPhoto(payload.chatId, payload.photoBase64, payload.caption || "📸 <b>Снимок экрана ПК</b>\n<i>(Изображение просмотрено и удалено)</i>");
        } else if (payload.message) {
          await sendTelegram(payload.chatId, payload.message);
        }
      }
    } catch (e) {
      console.error("agent_result error:", e);
    }
    return new Response(JSON.stringify({ ok: true }), { headers: { "Content-Type": "application/json" } });
  }

  // 2. Health check & Webhook registration
  if (req.method === "GET") {
    if (url.pathname.endsWith("/setWebhook")) {
      const webhookUrl = "https://rkzzfszozgleeujkxzlb.supabase.co/functions/v1/telegram-bot";
      const tgRes = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/setWebhook?url=${webhookUrl}`);
      const tgData = await tgRes.json();
      return new Response(JSON.stringify({ webhookUrl, telegram: tgData }, null, 2), {
        headers: { "Content-Type": "application/json" },
      });
    }

    const { isOnline } = await getPcOnlineStatus();
    return new Response(
      JSON.stringify({
        status: "online",
        service: "Командный Центр (Выжимка ОГЭ + Управление ПК)",
        project: "rkzzfszozgleeujkxzlb",
        pcOnline: isOnline,
        time: new Date().toISOString(),
      }),
      { headers: { "Content-Type": "application/json" } }
    );
  }

  if (req.method !== "POST") {
    return new Response("Method Not Allowed", { status: 405 });
  }

  try {
    const update = await req.json();
    const fromUser = ((update.message?.from?.username || update.callback_query?.from?.username || "") as string)
      .toLowerCase()
      .replace(/^@/, "");

    const chatId = update.message?.chat?.id || update.callback_query?.message?.chat?.id;

    // Strict Whitelist check
    if (!ALLOWED_USERNAMES.has(fromUser)) {
      if (chatId) {
        await sendTelegram(
          chatId,
          `⛔ <b>Доступ ограничен.</b>\nЭтот бот работает только для администраторов (@vakuq, @k1slyy, @nezovsky).`
        );
      }
      return new Response(JSON.stringify({ ok: true }));
    }

    // A. Handle Button Callbacks
    if (update.callback_query) {
      const cb = update.callback_query;
      const data = cb.data || "";
      await answerCallbackQuery(cb.id);

      if (data === "nav:main") {
        const keyboard = {
          inline_keyboard: [
            [
              { text: "🌐 Сайт «Выжимка ОГЭ»", callback_data: "nav:site" },
              { text: "💻 Управление ПК", callback_data: "nav:pc" }
            ],
            [
              { text: "📊 Статус системы", callback_data: "nav:status" }
            ]
          ]
        };
        await sendTelegram(
          chatId,
          `👋 <b>Главное меню командного центра</b>\n\n` +
          `Авторизован: <b>@${fromUser}</b> 🟢\n\n` +
          `Выберите направление для работы:`,
          "HTML",
          keyboard
        );
        return new Response(JSON.stringify({ ok: true }));
      }

      if (data === "nav:site") {
        const keyboard = {
          inline_keyboard: [
            [
              { text: "🤖 Выбор AI-модели", callback_data: "site:models" },
              { text: "📊 Статус сайта", callback_data: "site:check" }
            ],
            [
              { text: "🔄 Перезапустить деплой", callback_data: "site:redeploy" },
              { text: "⏪ Откатить коммит", callback_data: "site:rollback" }
            ],
            [
              { text: "🔙 Главное меню", callback_data: "nav:main" }
            ]
          ]
        };
        await sendTelegram(
          chatId,
          `🌐 <b>Управление сайтом «Выжимка ОГЭ»</b>\n\n` +
          `<b>Актуальные команды:</b>\n` +
          `🤖 <b>/ai</b> — выбор нейросети для правок сайта\n` +
          `📊 <b>/status</b> — проверка работы сайта и последний коммит\n` +
          `🌐 <b>/site</b> — открыть ссылку на сайт\n` +
          `🔄 <b>/redeploy</b> — перезапустить деплой на GitHub\n` +
          `📢 <b>/announcement ТЕКСТ</b> — повесить объявление на сайте\n` +
          `⏪ <b>/rollback</b> — откат последнего коммита\n` +
          `📄 <b>/file ПУТЬ</b> — посмотреть файл в репозитории\n\n` +
          `💡 <i>Напишите задачу текстом, чтобы ИИ изменил код сайта!</i>`,
          "HTML",
          keyboard
        );
        return new Response(JSON.stringify({ ok: true }));
      }

      if (data === "nav:pc") {
        const { isOnline } = await getPcOnlineStatus();
        const statusBadge = isOnline ? "🟢 В сети (Готов к действиям)" : "🔴 Не в сети (ПК выключен / агент спит)";
        const keyboard = {
          inline_keyboard: [
            [
              { text: "📸 Что на экране?", callback_data: "pc:screen" },
              { text: "⚡ Меню питания", callback_data: "pc:power" }
            ],
            [
              { text: "📊 Характеристики ПК", callback_data: "pc:info" }
            ],
            [
              { text: "🔙 Главное меню", callback_data: "nav:main" }
            ]
          ]
        };
        await sendTelegram(
          chatId,
          `💻 <b>Управление ПК (ИИ-Агент)</b>\n\n` +
          `Статус компьютера: <b>${statusBadge}</b>\n\n` +
          `<b>Доступные команды:</b>\n` +
          `📸 <b>/screen</b> — сделать скриншот экрана (ИИ посмотрит и пришлет в чат)\n` +
          `💻 <b>/cmd КОМАНДА</b> — выполнить команду PowerShell на ПК\n` +
          `⚡ <b>/power</b> — управление питанием (выключение, перезагрузка, сон)\n\n` +
          `🧠 <b>Умные действия голосом/текстом:</b>\n` +
          `Напишите задачу обычными словами: <i>«закрой окно»</i>, <i>«нажми Играть»</i>, <i>«посмотри что открыто»</i>. ИИ посмотрит на экран, нажмет нужную кнопку и тут же сотрет снимок!`,
          "HTML",
          keyboard
        );
        return new Response(JSON.stringify({ ok: true }));
      }

      if (data === "pc:screen") {
        const { isOnline } = await getPcOnlineStatus();
        if (!isOnline) {
          await sendTelegram(chatId, `⚠️ <b>ПК сейчас оффлайн.</b> Включите компьютер или запустите агента.`);
          return new Response(JSON.stringify({ ok: true }));
        }
        await addPcTask({
          chatId,
          username: fromUser,
          type: "screen"
        });
        await sendTelegram(chatId, `📸 <b>Делаю снимок экрана...</b> Подождите 1-2 секунды.`);
        return new Response(JSON.stringify({ ok: true }));
      }

      if (data === "pc:power") {
        const keyboard = {
          inline_keyboard: [
            [
              { text: "🔴 Выключить ПК", callback_data: "pwr:shutdown" },
              { text: "🔄 Перезагрузить", callback_data: "pwr:reboot" }
            ],
            [
              { text: "🌙 Спящий режим", callback_data: "pwr:sleep" },
              { text: "🔒 Заблокировать", callback_data: "pwr:lock" }
            ],
            [
              { text: "🔙 Назад в меню ПК", callback_data: "nav:pc" }
            ]
          ]
        };
        await sendTelegram(chatId, `⚡ <b>Меню питания компьютера:</b>\nВыберите действие:`, "HTML", keyboard);
        return new Response(JSON.stringify({ ok: true }));
      }

      if (data.startsWith("pwr:")) {
        const action = data.replace("pwr:", "");
        const { isOnline } = await getPcOnlineStatus();
        if (!isOnline) {
          await sendTelegram(chatId, `⚠️ ПК оффлайн. Команду отправить невозможно.`);
          return new Response(JSON.stringify({ ok: true }));
        }
        await addPcTask({
          chatId,
          username: fromUser,
          type: "power",
          instruction: action
        });
        await sendTelegram(chatId, `⚡ <b>Команда отправлена на ПК:</b> <code>${action}</code>`);
        return new Response(JSON.stringify({ ok: true }));
      }

      if (data === "pc:info") {
        const { isOnline, info } = await getPcOnlineStatus();
        if (!isOnline) {
          await sendTelegram(chatId, `🔴 <b>ПК сейчас оффлайн.</b>`);
          return new Response(JSON.stringify({ ok: true }));
        }
        let infoMsg = `📊 <b>Состояние ПК:</b> 🟢 Онлайн\n\n`;
        if (info?.freeDiskGB !== undefined) infoMsg += `• Свободно на диске C:: <b>${info.freeDiskGB} ГБ</b>\n`;
        if (info?.activeWindow) infoMsg += `• Активное окно: <i>${info.activeWindow}</i>\n`;
        await sendTelegram(chatId, infoMsg);
        return new Response(JSON.stringify({ ok: true }));
      }

      if (data === "site:models") {
        const keyboard = {
          inline_keyboard: [
            [{ text: "🌟 Лучший вариант (Автовыбор) — 100% 🟢", callback_data: "model:auto" }],
            [{ text: "🐰 Space Bunny Alpha — 99% 🟢", callback_data: "model:stealth/space-bunny-alpha" }],
            [{ text: "⚡ Nvidia Nemotron — 97% 🟢", callback_data: "model:nvidia/nemotron-3.5-lightning:free" }],
            [{ text: "🧠 Qwen 3.8 Coding — 95% 🟢", callback_data: "model:qwen/qwen3.8-27b:free" }],
            [{ text: "🔙 В меню сайта", callback_data: "nav:site" }]
          ]
        };
        await sendTelegram(chatId, `🤖 <b>Выбор AI-модели для сайта:</b>`, "HTML", keyboard);
        return new Response(JSON.stringify({ ok: true }));
      }

      if (data.startsWith("model:")) {
        const modelId = data.replace("model:", "");
        runtimeSelectedModel = modelId;
        await saveSecret("ACTIVE_AI_MODEL", modelId);
        await sendTelegram(chatId, `🎯 Модель переключена на: <code>${modelId}</code>`);
        return new Response(JSON.stringify({ ok: true }));
      }

      if (data === "site:check" || data === "nav:status") {
        const [commit, health, pcStatus] = await Promise.all([
          getGitHubCommit(GITHUB_REPO),
          checkSiteHealth(),
          getPcOnlineStatus()
        ]);
        const healthIcon = health.ok ? "🟢" : "🔴";
        const pcIcon = pcStatus.isOnline ? "🟢 В сети" : "🔴 Оффлайн";

        let msg = `📊 <b>Статус всей системы:</b>\n\n`;
        msg += `💻 <b>Компьютер:</b> ${pcIcon}\n`;
        msg += `🌐 <b>Сайт ОГЭ:</b> ${healthIcon} ${health.ok ? "Работает" : "Ошибка"} (${health.ms}ms)\n`;
        if (commit) {
          msg += `📦 <b>Коммит:</b> <code>${commit.sha}</code> (<i>${commit.message}</i>)\n`;
        }
        await sendTelegram(chatId, msg);
        return new Response(JSON.stringify({ ok: true }));
      }

      if (data === "site:redeploy") {
        await sendTelegram(chatId, `🔄 Отправляю сигнал на пересборку сайта в GitHub Pages...`);
        const res = await triggerRedeploy(GITHUB_REPO);
        if (res && res.commit) {
          await sendTelegram(chatId, `✅ <b>Сигнал отправлен!</b> Сайт обновится через 30-60 секунд.`);
        } else {
          await sendTelegram(chatId, `⚠️ Ошибка триггера GitHub.`);
        }
        return new Response(JSON.stringify({ ok: true }));
      }

      if (data === "site:rollback") {
        await sendTelegram(chatId, `⏪ Откатываю коммит...`);
        const rb = await rollbackCommit(GITHUB_REPO);
        if (rb) {
          await sendTelegram(chatId, `✅ <b>Откат успешен!</b> Отменен коммит: <code>${rb.revertedSha}</code>`);
        } else {
          await sendTelegram(chatId, `⚠️ Не удалось выполнить откат.`);
        }
        return new Response(JSON.stringify({ ok: true }));
      }

      return new Response(JSON.stringify({ ok: true }));
    }

    // B. Handle Text Messages
    const message = update.message;
    if (!message || !message.text) {
      return new Response(JSON.stringify({ ok: true }));
    }

    const text = message.text.trim();

    // /start command
    if (text === "/start" || text === "/help" || text === "/menu") {
      const { isOnline } = await getPcOnlineStatus();
      const pcBadge = isOnline ? "🟢 В сети" : "🔴 Оффлайн";

      const welcomeMsg = `🤖 <b>Командный центр администратора</b>\n\n` +
        `Привет, <b>@${fromUser}</b>! Бот готов к работе.\n` +
        `Статус ПК: <b>${pcBadge}</b>\n\n` +
        `<b>Выберите направление:</b>\n` +
        `🌐 <b>Сайт «Выжимка ОГЭ»</b> — управление кодом, деплой, AI-модели, баннеры\n` +
        `💻 <b>Управление ПК</b> — скриншоты, умные действия ИИ, консоль, питание\n\n` +
        `<i>(Выберите нужный раздел кнопками ниже)</i>`;

      const keyboard = {
        inline_keyboard: [
          [
            { text: "🌐 Сайт «Выжимка ОГЭ»", callback_data: "nav:site" },
            { text: "💻 Управление ПК", callback_data: "nav:pc" }
          ],
          [
            { text: "📸 Быстрый скриншот ПК", callback_data: "pc:screen" },
            { text: "📊 Статус системы", callback_data: "nav:status" }
          ]
        ]
      };

      await sendTelegram(chatId, welcomeMsg, "HTML", keyboard);
      return new Response(JSON.stringify({ ok: true }));
    }

    if (text === "/pc") {
      const { isOnline } = await getPcOnlineStatus();
      const statusBadge = isOnline ? "🟢 В сети" : "🔴 Оффлайн";
      const keyboard = {
        inline_keyboard: [
          [
            { text: "📸 Что на экране?", callback_data: "pc:screen" },
            { text: "⚡ Питание", callback_data: "pc:power" }
          ],
          [
            { text: "🔙 Главное меню", callback_data: "nav:main" }
          ]
        ]
      };
      await sendTelegram(chatId, `💻 <b>Управление ПК:</b> ${statusBadge}\nНапишите задачу текстом или выберите кнопку:`, "HTML", keyboard);
      return new Response(JSON.stringify({ ok: true }));
    }

    if (text === "/screen" || text.toLowerCase() === "скрин" || text.toLowerCase() === "экран") {
      const { isOnline } = await getPcOnlineStatus();
      if (!isOnline) {
        await sendTelegram(chatId, `⚠️ <b>Компьютер сейчас оффлайн.</b> Включите ПК или запустите агента.`);
        return new Response(JSON.stringify({ ok: true }));
      }
      await addPcTask({
        chatId,
        username: fromUser,
        type: "screen"
      });
      await sendTelegram(chatId, `📸 <b>Делаю снимок экрана...</b> Секунду.`);
      return new Response(JSON.stringify({ ok: true }));
    }

    if (text === "/power") {
      const keyboard = {
        inline_keyboard: [
          [
            { text: "🔴 Выключить", callback_data: "pwr:shutdown" },
            { text: "🔄 Перезагрузить", callback_data: "pwr:reboot" }
          ],
          [
            { text: "🌙 Сон", callback_data: "pwr:sleep" },
            { text: "🔒 Блокировка", callback_data: "pwr:lock" }
          ]
        ]
      };
      await sendTelegram(chatId, `⚡ <b>Управление питанием ПК:</b>`, "HTML", keyboard);
      return new Response(JSON.stringify({ ok: true }));
    }

    if (text.startsWith("/cmd ")) {
      const cmdStr = text.replace("/cmd ", "").trim();
      const { isOnline } = await getPcOnlineStatus();
      if (!isOnline) {
        await sendTelegram(chatId, `⚠️ ПК оффлайн. Невозможно выполнить команду.`);
        return new Response(JSON.stringify({ ok: true }));
      }
      await addPcTask({
        chatId,
        username: fromUser,
        type: "cmd",
        cmd: cmdStr
      });
      await sendTelegram(chatId, `⏳ Выполняю команду в PowerShell:\n<code>${cmdStr}</code>...`);
      return new Response(JSON.stringify({ ok: true }));
    }

    if (text === "/site") {
      await sendTelegram(chatId, `🌐 <b>Ссылка:</b> https://oge-vyzhimka.github.io/vijimka-oge/`);
      return new Response(JSON.stringify({ ok: true }));
    }

    if (text === "/status") {
      const [commit, health] = await Promise.all([getGitHubCommit(GITHUB_REPO), checkSiteHealth()]);
      const healthIcon = health.ok ? "🟢" : "🔴";
      let msg = `📊 <b>Статус сайта:</b> ${healthIcon} (${health.status}, ${health.ms}ms)\n`;
      if (commit) msg += `📦 Коммит <code>${commit.sha}</code>: <i>${commit.message}</i>\n`;
      await sendTelegram(chatId, msg);
      return new Response(JSON.stringify({ ok: true }));
    }

    if (text === "/redeploy") {
      await sendTelegram(chatId, `🔄 Сигнал на пересборку отправлен.`);
      await triggerRedeploy(GITHUB_REPO);
      return new Response(JSON.stringify({ ok: true }));
    }

    if (text === "/rollback") {
      const rb = await rollbackCommit(GITHUB_REPO);
      if (rb) await sendTelegram(chatId, `✅ <b>Откат успешен:</b> <code>${rb.revertedSha}</code>`);
      else await sendTelegram(chatId, `⚠️ Ошибка отката.`);
      return new Response(JSON.stringify({ ok: true }));
    }

    if (text.startsWith("/setkey ")) {
      const key = text.replace("/setkey ", "").trim();
      runtimeGeminiKey = key;
      await saveSecret("GEMINI_API_KEY", key);
      await sendTelegram(chatId, `✅ <b>Ключ сохранен в облаке!</b>`);
      return new Response(JSON.stringify({ ok: true }));
    }

    if (text.startsWith("/announcement ")) {
      const annText = text.replace("/announcement ", "").trim();
      const annJson = JSON.stringify({ active: true, text: annText, updatedAt: new Date().toISOString() }, null, 2);
      const cur = await getGitHubFile(GITHUB_REPO, "announcement.json");
      await putGitHubFile(GITHUB_REPO, "announcement.json", annJson, `[Bot] Update announcement`, cur?.sha);
      await sendTelegram(chatId, `✅ <b>Объявление опубликовано на сайте!</b>`);
      return new Response(JSON.stringify({ ok: true }));
    }

    // Natural Language Routing: Check if it's a PC task or a Website task
    const lower = text.toLowerCase();
    const isPcAction = [
      "экран", "закрой", "открой", "нажми", "клик", "сверни", "видео", "браузер",
      "включи", "выключи", "сделай", "посмотри", "мышь", "курсор", "плей", "играть",
      "запусти", "перезагрузи", "сверни", "папку", "диспетчер"
    ].some((w) => lower.includes(w));

    if (isPcAction) {
      const { isOnline } = await getPcOnlineStatus();
      if (!isOnline) {
        await sendTelegram(
          chatId,
          `⚠️ <b>Компьютер сейчас оффлайн.</b>\n` +
          `Чтобы ИИ мог управлять экраном, запустите агента на ПК.`
        );
        return new Response(JSON.stringify({ ok: true }));
      }

      await addPcTask({
        chatId,
        username: fromUser,
        type: "ai_action",
        instruction: text
      });

      await sendTelegram(
        chatId,
        `🧠 <b>ИИ анализирует экран...</b>\nЗадача: <i>"${text}"</i>\n` +
        `<i>(Скриншот делается, анализируется, выполняется действие и сразу удаляется)</i>`
      );
      return new Response(JSON.stringify({ ok: true }));
    }

    // Else: Website AI Task
    const apiKey = runtimeGeminiKey || Deno.env.get("GEMINI_API_KEY");
    if (!apiKey) {
      await sendTelegram(
        chatId,
        `🤖 Задача для сайта: <i>"${text}"</i>\nДля изменения кода подключите ключ OpenRouter: <code>/setkey КЛЮЧ</code>`
      );
      return new Response(JSON.stringify({ ok: true }));
    }

    const processAiTask = async () => {
      try {
        await sendTelegram(chatId, `🧠 Применяю правки на сайте...\n<i>"${text}"</i>`);
        let targetFile = "index.html";
        if (lower.includes("css") || lower.includes("стил") || lower.includes("цвет") || lower.includes("тем")) {
          targetFile = "css/styles.css";
        }
        const current = await getGitHubFile(GITHUB_REPO, targetFile);
        if (!current) {
          await sendTelegram(chatId, `❌ Не удалось прочитать ${targetFile}.`);
          return;
        }
        const aiRes = await askAI(text, current.content, apiKey, runtimeSelectedModel);
        if (aiRes.isAnswer && aiRes.message) {
          await sendTelegram(chatId, `🤖 <b>Ответ:</b>\n${aiRes.message}`);
          return;
        }
        if (!aiRes.success || !aiRes.updatedCode) {
          await sendTelegram(chatId, `⚠️ ${aiRes.error || "Ошибка изменения кода."}`);
          return;
        }
        const commitRes = await putGitHubFile(GITHUB_REPO, targetFile, aiRes.updatedCode, `[AI Bot] ${text.substring(0, 40)}`, current.sha);
        if (commitRes && commitRes.commit) {
          await sendTelegram(chatId, `🎉 <b>Сайт обновлен!</b> Коммит: <code>${commitRes.commit.sha?.substring(0, 7)}</code>`);
        } else {
          await sendTelegram(chatId, `❌ Ошибка пуша коммита.`);
        }
      } catch (err) {
        await sendTelegram(chatId, `⚠️ Ошибка: ${String(err)}`);
      }
    };

    // @ts-ignore EdgeRuntime
    if (typeof EdgeRuntime !== "undefined" && EdgeRuntime.waitUntil) {
      // @ts-ignore EdgeRuntime
      EdgeRuntime.waitUntil(processAiTask());
    } else {
      processAiTask().catch(console.error);
    }

    return new Response(JSON.stringify({ ok: true }));
  } catch (err) {
    console.error("Webhook processing error:", err);
    return new Response(JSON.stringify({ error: String(err) }), { status: 500 });
  }
});
