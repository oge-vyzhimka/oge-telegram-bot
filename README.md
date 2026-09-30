# 🤖 Vyjimka OGE — 24/7 Cloud Telegram Bot

Облачный бот для удаленного контроля и управления сайтом «Выжимка ОГЭ» из Telegram при выключенном компьютере.

## 🚀 Возможности
- 📊 `/status` — онлайн-мониторинг сайта и последний коммит на GitHub
- 🌐 `/site` — прямая ссылка на сайт
- 🔄 `/redeploy` — мгновенный запуск повторной сборки и сброса кэша GitHub Pages
- 📢 `/announcement <текст>` — установка баннера/объявления на сайте
- 📄 `/file <путь>` — просмотр любого файла репозитория (например, `index.html`)
- 🤖 **AI-управление**: отправь задачу текстом, и нейросеть применит правки в код сайта через GitHub API!

## ☁️ Развертывание в Supabase Edge Functions (24/7 бесплатно)
1. Выполните команду деплоя:
```bash
npx supabase functions deploy telegram-bot --project-ref rkzzfszozgleeujkxzlb --no-verify-jwt
```
2. Установите секреты в Supabase:
```bash
npx supabase secrets set TELEGRAM_BOT_TOKEN="8810493662:..." GITHUB_TOKEN="ghp_..."
```
3. Привяжите вебхук Telegram:
```
https://api.telegram.org/bot<TOKEN>/setWebhook?url=https://rkzzfszozgleeujkxzlb.supabase.co/functions/v1/telegram-bot
```
