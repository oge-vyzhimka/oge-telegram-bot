// Supabase Edge Function: 24/7 Telegram Bot for "Выжимка ОГЭ"
// Runs in Supabase Cloud on Deno (Zero cold-start, 24/7 online even when PC is off)

const TELEGRAM_BOT_TOKEN = Deno.env.get("TELEGRAM_BOT_TOKEN") || "";
const GITHUB_TOKEN = Deno.env.get("GITHUB_TOKEN") || "";
const GITHUB_REPO = Deno.env.get("GITHUB_REPO") || "oge-vyzhimka/vijimka-oge";
const ADMIN_SECRET = Deno.env.get("ADMIN_SECRET") || "vyzhimka2026";

// In-memory runtime cache for authorized users and optional Gemini key
const authorizedChats = new Set<number>();
let runtimeGeminiKey = Deno.env.get("GEMINI_API_KEY") || "";

async function sendTelegram(chatId: number, text: string, parseMode: string = "HTML") {
  try {
    const res = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        text,
        parse_mode: parseMode,
        disable_web_page_preview: false,
      }),
    });
    return await res.json();
  } catch (err) {
    console.error("Telegram send error:", err);
    return null;
  }
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

async function askAI(prompt: string, context: string, apiKey: string): Promise<{ success: boolean; updatedCode?: string; error?: string }> {
  const systemInstruction = `Ты AI-разработчик сайта "Выжимка ОГЭ". Твоя задача — редактировать исходный код сайта (index.html) по поручению владельца.
Файл большой. НЕ переписывай весь файл целиком!
Найди конкретное место в коде, которое нужно изменить, и верни ТОЛЬКО валидный JSON (без markdown блоков \`\`\`) следующего формата:
{
  "search": "точный фрагмент из текущего кода, который нужно заменить (2-5 строк)",
  "replace": "новый фрагмент, который должен встать на его место"
}`;

  try {
    // 1. OpenRouter (sk-or-...)
    if (apiKey.startsWith("sk-or-")) {
      const candidateModels = [
        "google/gemini-2.0-flash-exp:free",
        "meta-llama/llama-3.3-70b-instruct:free",
        "deepseek/deepseek-r1:free",
        "mistralai/mistral-7b-instruct:free",
        "qwen/qwen-2.5-coder-32b-instruct:free"
      ];

      let lastError = "";
      for (const model of candidateModels) {
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

          // Clean json
          const cleaned = rawContent.replace(/^```[a-z]*\n?/i, "").replace(/```$/i, "").trim();
          try {
            const parsed = JSON.parse(cleaned);
            if (parsed.search && parsed.replace !== undefined) {
              if (context.includes(parsed.search)) {
                return { success: true, updatedCode: context.replace(parsed.search, parsed.replace) };
              }
              // Try trimming search
              const trimmedSearch = parsed.search.trim();
              if (context.includes(trimmedSearch)) {
                return { success: true, updatedCode: context.replace(trimmedSearch, parsed.replace.trim()) };
              }
            }
          } catch (_) {
            // If model returned plain replacement instead of JSON
            if (cleaned.length > 50 && cleaned.includes("<")) {
              return { success: true, updatedCode: cleaned };
            }
          }
        } catch (e) {
          lastError = String(e);
        }
      }
      return { success: false, error: lastError || "Все бесплатные модели OpenRouter временно перегружены. Попробуй через минуту." };
    }

    // 2. Groq (gsk_...)
    if (apiKey.startsWith("gsk_")) {
      const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${apiKey}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          model: "llama-3.3-70b-versatile",
          response_format: { type: "json_object" },
          messages: [
            { role: "system", content: systemInstruction },
            { role: "user", content: `ЗАДАЧА ПОЛЬЗОВАТЕЛЯ:\n${prompt}\n\nКОД ДЛЯ СПРАВКИ:\n${context.substring(0, 20000)}` }
          ]
        })
      });
      const data = await res.json();
      if (!res.ok) {
        return { success: false, error: data?.error?.message || `Groq Error ${res.status}` };
      }
      const raw = data?.choices?.[0]?.message?.content;
      try {
        const parsed = JSON.parse(raw);
        if (parsed.search && parsed.replace !== undefined && context.includes(parsed.search.trim())) {
          return { success: true, updatedCode: context.replace(parsed.search.trim(), parsed.replace.trim()) };
        }
      } catch (_) {}
      return { success: false, error: "Не удалось найти точный фрагмент кода для замены. Попробуй указать конкретнее." };
    }

    // 3. Google Gemini (AIza...)
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

Deno.serve(async (req: Request) => {
  const url = new URL(req.url);

  // Health check / info
  if (req.method === "GET") {
    if (url.pathname.endsWith("/setWebhook")) {
      const webhookUrl = "https://rkzzfszozgleeujkxzlb.supabase.co/functions/v1/telegram-bot";
      const tgRes = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/setWebhook?url=${webhookUrl}`);
      const tgData = await tgRes.json();
      return new Response(JSON.stringify({ webhookUrl, telegram: tgData }, null, 2), {
        headers: { "Content-Type": "application/json" },
      });
    }

    return new Response(
      JSON.stringify({
        status: "online",
        service: "Выжимка ОГЭ Telegram Bot 24/7",
        project: "rkzzfszozgleeujkxzlb",
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
    const message = update.message;

    if (!message || !message.text) {
      return new Response(JSON.stringify({ ok: true }), { headers: { "Content-Type": "application/json" } });
    }

    const chatId = message.chat.id;
    const text = message.text.trim();
    const sender = message.from?.first_name || "Пользователь";

    // Auto-authorize first user or check passkey
    if (authorizedChats.size === 0) {
      authorizedChats.add(chatId);
    }

    if (text.startsWith("/auth")) {
      const pass = text.split(" ")[1];
      if (pass === ADMIN_SECRET) {
        authorizedChats.add(chatId);
        await sendTelegram(chatId, `✅ <b>Авторизация успешна!</b> Привет, ${sender}! Теперь у тебя полный доступ к управлению сайтом.`);
      } else {
        await sendTelegram(chatId, `❌ Неверный пароль. Используй: <code>/auth vyzhimka2026</code>`);
      }
      return new Response(JSON.stringify({ ok: true }));
    }

    if (!authorizedChats.has(chatId)) {
      await sendTelegram(
        chatId,
        `🔒 <b>Бот защищен.</b> Пожалуйста, авторизуйся командой:\n<code>/auth vyzhimka2026</code>`
      );
      return new Response(JSON.stringify({ ok: true }));
    }

    // Command handling
    if (text === "/start" || text === "/help") {
      const helpMsg = `🚀 <b>Панель управления сайтом «Выжимка ОГЭ» (24/7 Облако)</b>\n\n` +
        `Бот работает автономно в облаке <b>Supabase</b> и доступен даже когда твой ПК выключен!\n\n` +
        `<b>Доступные команды:</b>\n` +
        `📊 <b>/status</b> — проверка работы сайта и последний коммит\n` +
        `🌐 <b>/site</b> — открыть ссылку на сайт\n` +
        `🔄 <b>/redeploy</b> — перезапустить деплой на GitHub\n` +
        `📢 <b>/announcement ТЕКСТ</b> — повесить объявление на сайте\n` +
        `📄 <b>/file ПУТЬ</b> — посмотреть файл из репозитория (напр. <code>/file index.html</code>)\n` +
        `🔑 <b>/setkey КЛЮЧ</b> — подключить бесплатный Google Gemini API ключ для изменений кода\n\n` +
        `💡 <b>Управление сайтом голосом или текстом:</b>\n` +
        `Просто напиши задачу своими словами (например: <i>«поменяй заголовок в index.html на...»</i>), и бот внесет изменения в GitHub!`;

      await sendTelegram(chatId, helpMsg);
      return new Response(JSON.stringify({ ok: true }));
    }

    if (text === "/site") {
      await sendTelegram(
        chatId,
        `🌐 <b>Сайт Выжимка ОГЭ:</b>\n👉 <a href="https://oge-vyzhimka.github.io/vijimka-oge/">https://oge-vyzhimka.github.io/vijimka-oge/</a>`
      );
      return new Response(JSON.stringify({ ok: true }));
    }

    if (text === "/status") {
      await sendTelegram(chatId, `⏳ Проверяю статус сайта и GitHub...`);
      const [commit, health] = await Promise.all([
        getGitHubCommit(GITHUB_REPO),
        checkSiteHealth(),
      ]);

      const healthIcon = health.ok ? "🟢" : "🔴";
      let msg = `📊 <b>Статус сайта «Выжимка ОГЭ»:</b>\n\n`;
      msg += `${healthIcon} <b>Сайт онлайн:</b> ${health.ok ? "Работает отлично" : "Ошибка"} (${health.status}, ${health.ms}ms)\n`;
      msg += `🌐 <b>Ссылка:</b> https://oge-vyzhimka.github.io/vijimka-oge/\n\n`;

      if (commit) {
        msg += `📦 <b>Последний коммит:</b>\n`;
        msg += `• Хэш: <code>${commit.sha}</code>\n`;
        msg += `• Сообщение: <i>${commit.message}</i>\n`;
        msg += `• Автор: ${commit.author}\n`;
        msg += `• Время: ${commit.date} (МСК)\n`;
      }
      msg += `\n⚡ <i>Сервер бота: Supabase Edge 24/7 (ПК не требуется)</i>`;

      await sendTelegram(chatId, msg);
      return new Response(JSON.stringify({ ok: true }));
    }

    if (text === "/redeploy") {
      await sendTelegram(chatId, `🔄 Отправляю сигнал на пересборку в GitHub...`);
      const res = await triggerRedeploy(GITHUB_REPO);
      if (res && res.commit) {
        await sendTelegram(
          chatId,
          `✅ <b>Успешно!</b> Сигнал деплоя отправлен (коммит <code>${res.commit.sha?.substring(0, 7)}</code>).\nGitHub Pages обновит сайт в течение 30-60 секунд!`
        );
      } else {
        await sendTelegram(chatId, `⚠️ Не удалось отправить триггер деплоя. Ошибка GitHub API.`);
      }
      return new Response(JSON.stringify({ ok: true }));
    }

    if (text.startsWith("/file ")) {
      const filePath = text.replace("/file ", "").trim();
      await sendTelegram(chatId, `🔍 Ищу файл <code>${filePath}</code> на GitHub...`);
      const file = await getGitHubFile(GITHUB_REPO, filePath);
      if (file) {
        const preview = file.content.length > 3000 ? file.content.substring(0, 3000) + "\n...[обрезано]" : file.content;
        await sendTelegram(chatId, `📄 <b>Содержимое ${filePath}:</b>\n<pre>${preview.replace(/</g, "&lt;").replace(/>/g, "&gt;")}</pre>`);
      } else {
        await sendTelegram(chatId, `❌ Файл <code>${filePath}</code> не найден в репозитории.`);
      }
      return new Response(JSON.stringify({ ok: true }));
    }

    if (text.startsWith("/setkey ")) {
      const key = text.replace("/setkey ", "").trim();
      if (key.length > 8) {
        runtimeGeminiKey = key;
        await sendTelegram(chatId, `⏳ Сохраняю ключ в облаке Supabase...`);
        const saved = await saveSecret("GEMINI_API_KEY", key);
        if (saved) {
          await sendTelegram(chatId, `✅ <b>AI-ключ успешно сохранен в облаке насовсем!</b> Теперь я помню его 24/7 и готов менять код сайта по твоим текстовым командам.`);
        } else {
          await sendTelegram(chatId, `✅ <b>Ключ принят!</b> Готов к работе.`);
        }
      } else {
        await sendTelegram(chatId, `❌ Неверный формат ключа.`);
      }
      return new Response(JSON.stringify({ ok: true }));
    }

    if (text.startsWith("/announcement ")) {
      const annText = text.replace("/announcement ", "").trim();
      await sendTelegram(chatId, `📢 Публикую объявление на сайте: <i>"${annText}"</i>...`);
      const annJson = JSON.stringify({ active: true, text: annText, updatedAt: new Date().toISOString() }, null, 2);
      const cur = await getGitHubFile(GITHUB_REPO, "announcement.json");
      const res = await putGitHubFile(GITHUB_REPO, "announcement.json", annJson, `[Bot 24/7] Update announcement: ${annText.substring(0, 30)}`, cur?.sha);
      if (res && res.commit) {
        await sendTelegram(chatId, `✅ <b>Объявление опубликовано!</b> Сохранено в <code>announcement.json</code> на GitHub.`);
      } else {
        await sendTelegram(chatId, `❌ Ошибка публикации объявления.`);
      }
      return new Response(JSON.stringify({ ok: true }));
    }

    // Natural Language AI code modifications
    const apiKey = runtimeGeminiKey || Deno.env.get("GEMINI_API_KEY");
    if (!apiKey) {
      await sendTelegram(
        chatId,
        `🤖 Я получил твою задачу: <i>"${text}"</i>\n\n` +
        `Чтобы я мог изменять код сайта нейросетью при выключенном ПК, подключи бесплатный ключ <b>OpenRouter</b> (он работает в РФ без ограничений):\n` +
        `1. Зайди на <a href="https://openrouter.ai/">openrouter.ai</a> и нажми Sign In (через Google или GitHub)\n` +
        `2. Перейди в раздел Keys и создай ключ (начинается на <code>sk-or-...</code>)\n` +
        `3. Отправь мне команду: <code>/setkey ТВОЙ_КЛЮЧ</code>\n\n` +
        `<i>(Также поддерживаются ключи Groq или Google Gemini)</i>\n` +
        `А команды <b>/status</b>, <b>/site</b>, <b>/redeploy</b>, <b>/file</b> работают уже сейчас без ключей!`
      );
      return new Response(JSON.stringify({ ok: true }));
    }

    await sendTelegram(chatId, `🧠 Обрабатываю задачу с помощью AI...\n<i>"${text}"</i>`);

    // Default target is index.html
    const targetFile = "index.html";
    const current = await getGitHubFile(GITHUB_REPO, targetFile);
    if (!current) {
      await sendTelegram(chatId, `❌ Не удалось прочитать ${targetFile} с GitHub.`);
      return new Response(JSON.stringify({ ok: true }));
    }

    const aiRes = await askAI(text, current.content, apiKey);
    if (!aiRes.success || !aiRes.updatedCode || aiRes.updatedCode.length < 50) {
      await sendTelegram(chatId, `⚠️ <b>Ошибка AI:</b> ${aiRes.error || "Нейросеть не смогла сформировать код. Попробуй переформулировать задачу."}`);
      return new Response(JSON.stringify({ ok: true }));
    }
    const updatedCode = aiRes.updatedCode;

    await sendTelegram(chatId, `💾 Отправляю коммит в GitHub...`);
    const commitRes = await putGitHubFile(
      GITHUB_REPO,
      targetFile,
      updatedCode,
      `[AI Bot 24/7] ${text.substring(0, 50)}`,
      current.sha
    );

    if (commitRes && commitRes.commit) {
      await sendTelegram(
        chatId,
        `🎉 <b>Готово! Изменения применены на сайте!</b>\n` +
        `Коммит: <code>${commitRes.commit.sha?.substring(0, 7)}</code>\n` +
        `Файл: <code>${targetFile}</code>\n` +
        `Сайт обновится через минуту: <a href="https://oge-vyzhimka.github.io/vijimka-oge/">Открыть сайт</a>`
      );
    } else {
      await sendTelegram(chatId, `❌ Не удалось запушить коммит в GitHub. Проверь права токена.`);
    }

    return new Response(JSON.stringify({ ok: true }), { headers: { "Content-Type": "application/json" } });
  } catch (err) {
    console.error("Webhook processing error:", err);
    return new Response(JSON.stringify({ error: String(err) }), { status: 500, headers: { "Content-Type": "application/json" } });
  }
});
