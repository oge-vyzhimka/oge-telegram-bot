// Universal Node.js Webhook Server for Telegram Bot (Render / Koyeb / Railway / Docker / Local)
const http = require('http');
const https = require('https');

const PORT = process.env.PORT || 3000;
const TELEGRAM_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
const GITHUB_TOKEN = process.env.GITHUB_TOKEN || '';
const GITHUB_REPO = process.env.GITHUB_REPO || 'oge-vyzhimka/vijimka-oge';
const ADMIN_SECRET = process.env.ADMIN_SECRET || 'vyzhimka2026';

const authorizedChats = new Set();
let runtimeGeminiKey = process.env.GEMINI_API_KEY || '';

function httpRequest(url, options = {}, data = null) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const lib = parsed.protocol === 'https:' ? https : http;
    const req = lib.request(url, options, (res) => {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, data: JSON.parse(body), raw: body });
        } catch (_) {
          resolve({ status: res.statusCode, raw: body });
        }
      });
    });
    req.on('error', reject);
    if (data) req.write(typeof data === 'string' ? data : JSON.stringify(data));
    req.end();
  });
}

async function sendTelegram(chatId, text, parseMode = 'HTML') {
  return httpRequest(
    `https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    },
    { chat_id: chatId, text, parse_mode: parseMode }
  );
}

async function getGitHubCommit(repo) {
  try {
    const res = await httpRequest(`https://api.github.com/repos/${repo}/commits?per_page=1`, {
      headers: {
        'Authorization': `token ${GITHUB_TOKEN}`,
        'User-Agent': 'VyjimkaBot',
      },
    });
    if (Array.isArray(res.data) && res.data.length > 0) {
      const c = res.data[0];
      return {
        sha: c.sha.substring(0, 7),
        message: c.commit.message,
        author: c.commit.author.name,
        date: new Date(c.commit.author.date).toLocaleString('ru-RU', { timeZone: 'Europe/Moscow' }),
      };
    }
  } catch (e) {
    console.error('GH Commit error:', e);
  }
  return null;
}

async function checkSiteHealth() {
  try {
    const t0 = Date.now();
    const res = await httpRequest('https://oge-vyzhimka.github.io/vijimka-oge/', { method: 'HEAD' });
    return { status: res.status, ok: res.status >= 200 && res.status < 400, ms: Date.now() - t0 };
  } catch (e) {
    return { status: 0, ok: false, ms: 0 };
  }
}

async function triggerRedeploy(repo) {
  try {
    const now = new Date().toISOString();
    const path = '.github_deploy_trigger';
    let sha = undefined;
    const cur = await httpRequest(`https://api.github.com/repos/${repo}/contents/${path}?ref=main`, {
      headers: { 'Authorization': `token ${GITHUB_TOKEN}`, 'User-Agent': 'VyjimkaBot' },
    });
    if (cur.status === 200 && cur.data && cur.data.sha) {
      sha = cur.data.sha;
    }
    const contentB64 = Buffer.from(`Last remote deploy trigger: ${now}\nTriggered via Telegram Bot 24/7 Cloud\n`).toString('base64');
    const putRes = await httpRequest(`https://api.github.com/repos/${repo}/contents/${path}`, {
      method: 'PUT',
      headers: { 'Authorization': `token ${GITHUB_TOKEN}`, 'Content-Type': 'application/json', 'User-Agent': 'VyjimkaBot' },
    }, {
      message: `[Bot 24/7] Re-deploy triggered at ${now}`,
      content: contentB64,
      sha: sha,
      branch: 'main'
    });
    return putRes.data;
  } catch (e) {
    console.error('Redeploy error:', e);
    return null;
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  if (req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ status: 'online', service: 'Выжимка ОГЭ Telegram Bot 24/7', time: new Date().toISOString() }));
  }

  if (req.method === 'POST') {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', async () => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));

      try {
        const update = JSON.parse(raw);
        const msg = update.message;
        if (!msg || !msg.text) return;

        const chatId = msg.chat.id;
        const text = msg.text.trim();
        const sender = msg.from ? msg.from.first_name : 'Друг';

        if (authorizedChats.size === 0) authorizedChats.add(chatId);

        if (text.startsWith('/auth')) {
          const pass = text.split(' ')[1];
          if (pass === ADMIN_SECRET) {
            authorizedChats.add(chatId);
            return sendTelegram(chatId, `✅ <b>Авторизация успешна!</b> Привет, ${sender}! Теперь у тебя полный доступ к сайту.`);
          }
          return sendTelegram(chatId, `❌ Неверный пароль. Введи: <code>/auth vyzhimka2026</code>`);
        }

        if (!authorizedChats.has(chatId)) {
          return sendTelegram(chatId, `🔒 <b>Бот защищен.</b> Авторизуйся командой:\n<code>/auth vyzhimka2026</code>`);
        }

        if (text === '/start' || text === '/help') {
          return sendTelegram(
            chatId,
            `🚀 <b>Панель управления «Выжимка ОГЭ» (24/7 Облако)</b>\n\n` +
            `Бот работает автономно в облаке и доступен при выключенном ПК!\n\n` +
            `📊 <b>/status</b> — проверка работы сайта и последний коммит\n` +
            `🌐 <b>/site</b> — прямая ссылка на сайт\n` +
            `🔄 <b>/redeploy</b> — перезапустить деплой на GitHub\n` +
            `📢 <b>/announcement ТЕКСТ</b> — объявление на сайте\n` +
            `🔑 <b>/setkey КЛЮЧ</b> — ключ Gemini API для AI правок\n\n` +
            `💡 <b>AI задачи:</b> напиши любую команду текстом, и я внесу правку в репозиторий через GitHub API!`
          );
        }

        if (text === '/site') {
          return sendTelegram(chatId, `🌐 <b>Сайт Выжимка ОГЭ:</b>\n👉 <a href="https://oge-vyzhimka.github.io/vijimka-oge/">https://oge-vyzhimka.github.io/vijimka-oge/</a>`);
        }

        if (text === '/status') {
          await sendTelegram(chatId, '⏳ Проверяю статус сайта и GitHub...');
          const [commit, health] = await Promise.all([getGitHubCommit(GITHUB_REPO), checkSiteHealth()]);
          let reply = `📊 <b>Статус сайта «Выжимка ОГЭ»:</b>\n\n`;
          reply += `${health.ok ? '🟢' : '🔴'} <b>Сайт онлайн:</b> ${health.ok ? 'Работает отлично' : 'Ошибка'} (${health.status}, ${health.ms}ms)\n`;
          reply += `🌐 <b>Ссылка:</b> https://oge-vyzhimka.github.io/vijimka-oge/\n\n`;
          if (commit) {
            reply += `📦 <b>Последний коммит:</b>\n`;
            reply += `• Хэш: <code>${commit.sha}</code>\n`;
            reply += `• Текст: <i>${commit.message}</i>\n`;
            reply += `• Автор: ${commit.author}\n`;
            reply += `• Время: ${commit.date} (МСК)\n`;
          }
          reply += `\n⚡ <i>Сервер бота: 24/7 Cloud (ПК выключен)</i>`;
          return sendTelegram(chatId, reply);
        }

        if (text === '/redeploy') {
          await sendTelegram(chatId, '🔄 Отправляю сигнал на пересборку в GitHub...');
          const res = await triggerRedeploy(GITHUB_REPO);
          if (res && res.commit) {
            return sendTelegram(chatId, `✅ <b>Успешно!</b> Сигнал деплоя отправлен (коммит <code>${res.commit.sha ? res.commit.sha.substring(0, 7) : 'new'}</code>).\nСайт обновится через 30-60 сек!`);
          }
          return sendTelegram(chatId, '⚠️ Не удалось отправить сигнал пересборки.');
        }

        if (text.startsWith('/setkey ')) {
          runtimeGeminiKey = text.replace('/setkey ', '').trim();
          return sendTelegram(chatId, '✅ <b>Ключ Gemini API сохранен!</b> Теперь можешь давать любые AI задания.');
        }

        // Default response for AI tasks
        return sendTelegram(
          chatId,
          `🤖 Получил задачу: <i>"${text}"</i>\n\nЧтобы я мог менять код с помощью ИИ, отправь ключ: <code>/setkey ТВОЙ_КЛЮЧ</code> (бесплатно на aistudio.google.com). Либо используй команды <b>/status</b> или <b>/redeploy</b>!`
        );
      } catch (err) {
        console.error('Webhook error:', err);
      }
    });
  }
});

server.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});
