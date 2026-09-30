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

async function askGemini(prompt: string, context: string, apiKey: string) {
  try {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${apiKey}`;
    const systemInstruction = `Ты AI-разработчик сайта "Выжимка ОГЭ". Твоя задача — редактировать исходный код сайта по поручению владельца.
Верни ТОЛЬКО обновленный готовый код файла целиком, без markdown блоков \`\`\` или лишних пояснений, чтобы код можно было сразу сохранить в репозиторий.`;

    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [
          {
            role: "user",
            parts: [
              { text: `${systemInstruction}\n\nКОНТЕКСТ ТЕКУЩЕГО ФАЙЛА:\n${context}\n\nЗАДАЧА ПОЛЬЗОВАТЕЛЯ:\n${prompt}` }
            ]
          }
        ]
      })
    });
    const data = await res.json();
    const answer = data?.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!answer) return null;
    return answer.replace(/^```[a-z]*\n?/i, "").replace(/```$/i, "").trim();
  } catch (err) {
    console.error("Gemini API error:", err);
    return null;
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
      if (key.length > 10) {
        runtimeGeminiKey = key;
        await sendTelegram(chatId, `✅ <b>Ключ Gemini API успешно сохранен!</b> Теперь я могу вносить любые изменения в код сайта по твоим текстовым командам.`);
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
        `Чтобы я мог автоматически изменять код сайта нейросетью при выключенном ПК, подключи бесплатный ключ Google Gemini API:\n` +
        `1. Перейди на <a href="https://aistudio.google.com/">aistudio.google.com</a> (Get API Key)\n` +
        `2. Отправь мне команду: <code>/setkey ТВОЙ_КЛЮЧ</code>\n\n` +
        `А пока ты можешь использовать команды <b>/status</b>, <b>/site</b>, <b>/redeploy</b>, <b>/announcement</b>!`
      );
      return new Response(JSON.stringify({ ok: true }));
    }

    await sendTelegram(chatId, `🧠 Думаю над задачей с помощью Gemini 2.0 Flash...\n<i>"${text}"</i>`);

    // Default target is index.html
    const targetFile = "index.html";
    const current = await getGitHubFile(GITHUB_REPO, targetFile);
    if (!current) {
      await sendTelegram(chatId, `❌ Не удалось прочитать ${targetFile} с GitHub.`);
      return new Response(JSON.stringify({ ok: true }));
    }

    const updatedCode = await askGemini(text, current.content, apiKey);
    if (!updatedCode || updatedCode.length < 50) {
      await sendTelegram(chatId, `⚠️ Нейросеть не смогла сформировать корректный код. Попробуй уточнить задачу.`);
      return new Response(JSON.stringify({ ok: true }));
    }

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
