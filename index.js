require('dotenv').config();
const { Telegraf } = require('telegraf');
const Database = require('better-sqlite3');
const axios = require('axios');

// ─── Config ────────────────────────────────────────────────────────────────
const BOT_TOKEN  = process.env.BOT_TOKEN;
const ADMIN_ID   = parseInt(process.env.ADMIN_ID, 10);
const ONLYSQ_KEY = process.env.ONLYSQ_API_KEY || '';

if (!BOT_TOKEN || !ADMIN_ID) {
  console.error('❌  Укажите BOT_TOKEN и ADMIN_ID в .env');
  process.exit(1);
}

// ─── Database ───────────────────────────────────────────────────────────────
const db = new Database('dreinn.db');

db.exec(`
  CREATE TABLE IF NOT EXISTS settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS disabled_users (
    user_id    INTEGER PRIMARY KEY,
    chat_id    INTEGER,
    first_name TEXT,
    disabled_at TEXT DEFAULT (datetime('now','localtime'))
  );

  CREATE TABLE IF NOT EXISTS conversations (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id    INTEGER NOT NULL,
    role       TEXT NOT NULL,
    content    TEXT NOT NULL,
    created_at TEXT DEFAULT (datetime('now','localtime'))
  );

  CREATE TABLE IF NOT EXISTS business_connections (
    connection_id TEXT PRIMARY KEY,
    user_id       INTEGER NOT NULL,
    is_enabled    INTEGER NOT NULL DEFAULT 1,
    connected_at  TEXT DEFAULT (datetime('now','localtime'))
  );
`);

const DEFAULTS = {
  model:       'gpt-5.1-chat',
  skill:       'Ты — дружелюбный и профессиональный помощник технической поддержки сервиса Dreinn VPN. ' +
               'Помогай пользователям решать проблемы с подключением, настройкой, оплатой и использованием VPN. ' +
               'Отвечай кратко, по делу и вежливо. Всегда отвечай на том языке, на котором пишет пользователь.',
  max_history: '8',
};

function getSetting(key) {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return row ? row.value : DEFAULTS[key] ?? null;
}
function setSetting(key, value) {
  db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run(key, value);
}

function isDisabled(userId) {
  return !!db.prepare('SELECT 1 FROM disabled_users WHERE user_id = ?').get(userId);
}
function disableUser(userId, chatId, firstName) {
  db.prepare('INSERT OR REPLACE INTO disabled_users (user_id, chat_id, first_name) VALUES (?, ?, ?)')
    .run(userId, chatId, firstName);
}
function enableUser(userId) {
  db.prepare('DELETE FROM disabled_users WHERE user_id = ?').run(userId);
  db.prepare('DELETE FROM conversations WHERE user_id = ?').run(userId);
}

function getHistory(userId) {
  const limit = parseInt(getSetting('max_history'), 10) * 2;
  return db.prepare(
    'SELECT role, content FROM conversations WHERE user_id = ? ORDER BY id DESC LIMIT ?'
  ).all(userId, limit).reverse();
}
function addMessage(userId, role, content) {
  db.prepare('INSERT INTO conversations (user_id, role, content) VALUES (?, ?, ?)').run(userId, role, content);
  // Удаляем старые сообщения, оставляем только нужное кол-во
  const maxRows = parseInt(getSetting('max_history'), 10) * 2 + 10;
  db.prepare(`
    DELETE FROM conversations WHERE user_id = ? AND id NOT IN (
      SELECT id FROM conversations WHERE user_id = ? ORDER BY id DESC LIMIT ?
    )
  `).run(userId, userId, maxRows);
}

// ─── OnlySq AI ───────────────────────────────────────────────────────────────
async function fetchAIResponse(userId, userText) {
  const model   = getSetting('model');
  const skill   = getSetting('skill');
  const history = getHistory(userId);

  const messages = [
    { role: 'system', content: skill },
    ...history,
    { role: 'user', content: userText },
  ];

  const headers = { 'Content-Type': 'application/json' };
  if (ONLYSQ_KEY) headers['Authorization'] = `Bearer ${ONLYSQ_KEY}`;

  const { data } = await axios.post(
    'https://api.onlysq.ru/ai/v2',
    { model, request: { messages } },
    { headers, timeout: 30_000 }
  );

  // OnlySq v2 оборачивает ответ в поле `answer` (OpenAI-совместимый объект)
  const answer =
    data?.answer?.choices?.[0]?.message?.content ??
    data?.choices?.[0]?.message?.content         ??
    data?.answer?.content                         ??
    data?.message?.content                        ??
    data?.content                                 ??
    null;

  if (!answer) {
    console.error('[AI] Неожиданный формат ответа:', JSON.stringify(data).slice(0, 500));
    throw new Error('Неожиданный формат ответа от OnlySq API');
  }

  return answer;
}

async function fetchModels() {
  const headers = {};
  if (ONLYSQ_KEY) headers['Authorization'] = `Bearer ${ONLYSQ_KEY}`;
  const { data } = await axios.get('https://api.onlysq.ru/ai/models', { headers, timeout: 10_000 });
  return data;
}

// ─── Bot ─────────────────────────────────────────────────────────────────────
const bot = new Telegraf(BOT_TOKEN);

// Состояния ввода для админа
const adminState = new Map(); // ADMIN_ID → { step, ... }

function isAdmin(ctx) {
  return ctx.from?.id === ADMIN_ID;
}

// ─── Keyboards ───────────────────────────────────────────────────────────────
function mainAdminKeyboard() {
  return {
    inline_keyboard: [
      [
        { text: ' Сменить модель',    callback_data: 'a:model',   icon_custom_emoji_id: '6030400221232501136' },
        { text: ' Изменить скилл',   callback_data: 'a:skill',   icon_custom_emoji_id: '5870753782874246579' },
      ],
      [
        { text: ' Список моделей',  callback_data: 'a:models',  icon_custom_emoji_id: '5769289093221454192' },
        { text: ' Статистика',      callback_data: 'a:stats',   icon_custom_emoji_id: '5870921681735781843' },
      ],
      [
        { text: ' Пользователи',    callback_data: 'a:users',   icon_custom_emoji_id: '5870772616305839506' },
      ],
    ],
  };
}

function backKeyboard(cb = 'a:main') {
  return { inline_keyboard: [[{ text: '◁ Назад', callback_data: cb }]] };
}

// ─── /start ───────────────────────────────────────────────────────────────────
bot.command('start', async (ctx) => {
  if (!isAdmin(ctx)) {
    return ctx.reply(
      '<tg-emoji emoji-id="5870657884844462243">❌</tg-emoji> <b>Доступ запрещён.</b>',
      { parse_mode: 'HTML' }
    );
  }

  adminState.delete(ADMIN_ID);
  const model = getSetting('model');
  const skill = getSetting('skill');

  await ctx.reply(
    `<tg-emoji emoji-id="6030400221232501136">🤖</tg-emoji> <b>Dreinn VPN — Панель управления</b>\n\n` +
    `<tg-emoji emoji-id="6030400221232501136">🤖</tg-emoji> <b>Модель:</b> <code>${model}</code>\n` +
    `<tg-emoji emoji-id="5870753782874246579">✍️</tg-emoji> <b>Скилл:</b>\n<i>${skill.slice(0, 120)}${skill.length > 120 ? '…' : ''}</i>\n\n` +
    `<tg-emoji emoji-id="6028435952299413210">ℹ️</tg-emoji> Привяжите бота к аккаунту в разделе <b>Telegram Business → Чат-бот</b>.`,
    { parse_mode: 'HTML', reply_markup: mainAdminKeyboard() }
  );
});

// ─── Callbacks ───────────────────────────────────────────────────────────────
bot.on('callback_query', async (ctx) => {
  if (!isAdmin(ctx)) {
    await ctx.answerCbQuery('❌ Нет доступа', { show_alert: true });
    return;
  }

  const data = ctx.callbackQuery?.data ?? '';
  await ctx.answerCbQuery().catch(() => {});

  // ── Главное меню ──────────────────────────────────────────────────────────
  if (data === 'a:main') {
    adminState.delete(ADMIN_ID);
    const model = getSetting('model');
    const skill = getSetting('skill');
    return ctx.editMessageText(
      `<tg-emoji emoji-id="6030400221232501136">🤖</tg-emoji> <b>Dreinn VPN — Панель управления</b>\n\n` +
      `<tg-emoji emoji-id="6030400221232501136">🤖</tg-emoji> <b>Модель:</b> <code>${model}</code>\n` +
      `<tg-emoji emoji-id="5870753782874246579">✍️</tg-emoji> <b>Скилл:</b>\n<i>${skill.slice(0, 120)}${skill.length > 120 ? '…' : ''}</i>`,
      { parse_mode: 'HTML', reply_markup: mainAdminKeyboard() }
    );
  }

  // ── Смена модели ──────────────────────────────────────────────────────────
  if (data === 'a:model') {
    adminState.set(ADMIN_ID, { step: 'model' });
    return ctx.editMessageText(
      `<tg-emoji emoji-id="6030400221232501136">🤖</tg-emoji> <b>Смена модели</b>\n\n` +
      `Текущая: <code>${getSetting('model')}</code>\n\n` +
      `Выберите из популярных или введите название вручную:`,
      {
        parse_mode: 'HTML',
        reply_markup: {
          inline_keyboard: [
            [{ text: 'gpt-5.1-chat',              callback_data: 'a:setmodel:gpt-5.1-chat' }],
            [{ text: 'gpt-4.1-mini',              callback_data: 'a:setmodel:gpt-4.1-mini' }],
            [{ text: 'gpt-4o',                    callback_data: 'a:setmodel:gpt-4o' }],
            [{ text: 'claude-sonnet-4-5',         callback_data: 'a:setmodel:claude-sonnet-4-5' }],
            [{ text: 'gemini-2.0-flash',          callback_data: 'a:setmodel:gemini-2.0-flash' }],
            [{ text: 'deepseek-r1',               callback_data: 'a:setmodel:deepseek-r1' }],
            [{ text: '◁ Назад',                   callback_data: 'a:main' }],
          ],
        },
      }
    );
  }

  if (data.startsWith('a:setmodel:')) {
    const model = data.replace('a:setmodel:', '');
    setSetting('model', model);
    adminState.delete(ADMIN_ID);
    return ctx.editMessageText(
      `<tg-emoji emoji-id="5870633910337015697">✅</tg-emoji> <b>Модель установлена!</b>\n\n` +
      `<code>${model}</code>`,
      { parse_mode: 'HTML', reply_markup: backKeyboard() }
    );
  }

  // ── Изменить скилл ───────────────────────────────────────────────────────
  if (data === 'a:skill') {
    adminState.set(ADMIN_ID, { step: 'skill' });
    return ctx.editMessageText(
      `<tg-emoji emoji-id="5870753782874246579">✍️</tg-emoji> <b>Системный промпт (скилл)</b>\n\n` +
      `<b>Текущий:</b>\n<i>${getSetting('skill')}</i>\n\n` +
      `<tg-emoji emoji-id="6028435952299413210">ℹ️</tg-emoji> Отправьте новый текст системного промпта:`,
      { parse_mode: 'HTML', reply_markup: backKeyboard() }
    );
  }

  // ── Список моделей API ───────────────────────────────────────────────────
  if (data === 'a:models') {
    try {
      const raw = await fetchModels();

      // Извлекаем только ID/name из любой структуры ответа
      let modelIds = [];
      if (Array.isArray(raw)) {
        modelIds = raw.map((m) => {
          if (typeof m === 'string') return m;
          return m?.id ?? m?.name ?? m?.model ?? JSON.stringify(m);
        }).filter(Boolean);
      } else if (raw?.data && Array.isArray(raw.data)) {
        // OpenAI-совместимый формат: { data: [ { id: "..." }, ... ] }
        modelIds = raw.data.map((m) => m?.id ?? m?.name ?? String(m)).filter(Boolean);
      } else if (raw?.models && Array.isArray(raw.models)) {
        modelIds = raw.models.map((m) => m?.id ?? m?.name ?? String(m)).filter(Boolean);
      } else {
        // Последний шанс — вытащить строки рекурсивно
        modelIds = extractStrings(raw).slice(0, 40);
      }

      const list = modelIds.slice(0, 40)
        .map((id) => `• <code>${escapeHtml(String(id))}</code>`)
        .join('\n') || '<i>Список пуст</i>';

      return ctx.editMessageText(
        `<tg-emoji emoji-id="6030400221232501136">🤖</tg-emoji> <b>Доступные модели OnlySq</b>\n\n${list}`,
        { parse_mode: 'HTML', reply_markup: backKeyboard() }
      );
    } catch (e) {
      return ctx.editMessageText(
        `<tg-emoji emoji-id="5870657884844462243">❌</tg-emoji> Ошибка: <code>${escapeHtml(e.message)}</code>`,
        { parse_mode: 'HTML', reply_markup: backKeyboard() }
      );
    }
  }

  // ── Статистика ───────────────────────────────────────────────────────────
  if (data === 'a:stats') {
    const totalUsers   = db.prepare('SELECT COUNT(DISTINCT user_id) AS n FROM conversations').get()?.n ?? 0;
    const totalMsgs    = db.prepare("SELECT COUNT(*) AS n FROM conversations WHERE role = 'user'").get()?.n ?? 0;
    const disabledCnt  = db.prepare('SELECT COUNT(*) AS n FROM disabled_users').get()?.n ?? 0;
    const connCnt      = db.prepare("SELECT COUNT(*) AS n FROM business_connections WHERE is_enabled = 1").get()?.n ?? 0;

    return ctx.editMessageText(
      `<tg-emoji emoji-id="5870921681735781843">📊</tg-emoji> <b>Статистика</b>\n\n` +
      `<tg-emoji emoji-id="5870772616305839506">👥</tg-emoji> Уникальных пользователей: <b>${totalUsers}</b>\n` +
      `<tg-emoji emoji-id="5870753782874246579">✍️</tg-emoji> Входящих сообщений: <b>${totalMsgs}</b>\n` +
      `<tg-emoji emoji-id="5870657884844462243">❌</tg-emoji> Отключили ИИ: <b>${disabledCnt}</b>\n` +
      `<tg-emoji emoji-id="6039422865189638057">📣</tg-emoji> Business подключений: <b>${connCnt}</b>\n\n` +
      `<tg-emoji emoji-id="6030400221232501136">🤖</tg-emoji> Текущая модель: <code>${getSetting('model')}</code>`,
      { parse_mode: 'HTML', reply_markup: backKeyboard() }
    );
  }

  // ── Пользователи ─────────────────────────────────────────────────────────
  if (data === 'a:users') {
    return showUsersPage(ctx, false);
  }
  if (data === 'a:users:edit') {
    return showUsersPage(ctx, true);
  }

  if (data.startsWith('a:enable:')) {
    const uid = parseInt(data.replace('a:enable:', ''), 10);
    enableUser(uid);
    return showUsersPage(ctx, true);
  }
});

async function showUsersPage(ctx, editMode) {
  const rows = db.prepare(
    'SELECT user_id, first_name, disabled_at FROM disabled_users ORDER BY disabled_at DESC LIMIT 15'
  ).all();

  let text =
    `<tg-emoji emoji-id="5870772616305839506">👥</tg-emoji> <b>Пользователи с отключённым ИИ</b>\n\n`;

  if (rows.length === 0) {
    text += '<i>Нет пользователей с отключённым ИИ.</i>';
  } else {
    rows.forEach((r) => {
      text += `<tg-emoji emoji-id="5870657884844462243">❌</tg-emoji> ` +
              `<b>${r.first_name || 'ID ' + r.user_id}</b> (<code>${r.user_id}</code>) — ${r.disabled_at}\n`;
    });
  }

  const btnRows = rows.map((r) => ([{
    text: `Включить ${r.first_name || r.user_id}`,
    callback_data: `a:enable:${r.user_id}`,
    icon_custom_emoji_id: '5870633910337015697',
  }]));
  btnRows.push([{ text: '◁ Назад', callback_data: 'a:main' }]);

  const fn = editMode
    ? (t, o) => ctx.editMessageText(t, o)
    : (t, o) => ctx.editMessageText(t, o);
  return fn(text, { parse_mode: 'HTML', reply_markup: { inline_keyboard: btnRows } });
}

// ─── Текстовый ввод от админа (состояние) ────────────────────────────────────
bot.on('text', async (ctx) => {
  // Только если это прямой чат, не business_message
  if (ctx.update?.business_message) return;

  if (!isAdmin(ctx)) return;

  const state = adminState.get(ADMIN_ID);
  if (!state) return;

  const text = ctx.message.text.trim();

  if (state.step === 'model') {
    setSetting('model', text);
    adminState.delete(ADMIN_ID);
    return ctx.reply(
      `<tg-emoji emoji-id="5870633910337015697">✅</tg-emoji> <b>Модель установлена:</b> <code>${text}</code>`,
      { parse_mode: 'HTML', reply_markup: mainAdminKeyboard() }
    );
  }

  if (state.step === 'skill') {
    setSetting('skill', text);
    adminState.delete(ADMIN_ID);
    return ctx.reply(
      `<tg-emoji emoji-id="5870633910337015697">✅</tg-emoji> <b>Скилл обновлён!</b>\n\n` +
      `<i>${text.slice(0, 200)}${text.length > 200 ? '…' : ''}</i>`,
      { parse_mode: 'HTML', reply_markup: mainAdminKeyboard() }
    );
  }
});

// ─── Business Connection ──────────────────────────────────────────────────────
bot.on('business_connection', async (ctx) => {
  const conn = ctx.businessConnection;
  if (!conn) return;

  if (conn.is_enabled) {
    db.prepare(
      'INSERT OR REPLACE INTO business_connections (connection_id, user_id, is_enabled) VALUES (?, ?, 1)'
    ).run(conn.id, conn.user.id);

    await ctx.telegram.sendMessage(
      ADMIN_ID,
      `<tg-emoji emoji-id="5870633910337015697">✅</tg-emoji> <b>Business аккаунт подключён!</b>\n\n` +
      `<tg-emoji emoji-id="6030400221232501136">🤖</tg-emoji> Бот готов отвечать клиентам от вашего имени.\n` +
      `<tg-emoji emoji-id="6028435952299413210">ℹ️</tg-emoji> ID подключения: <code>${conn.id}</code>`,
      { parse_mode: 'HTML' }
    );
  } else {
    db.prepare(
      'UPDATE business_connections SET is_enabled = 0 WHERE connection_id = ?'
    ).run(conn.id);

    await ctx.telegram.sendMessage(
      ADMIN_ID,
      `<tg-emoji emoji-id="5870657884844462243">❌</tg-emoji> <b>Business подключение отключено.</b>\n` +
      `ID: <code>${conn.id}</code>`,
      { parse_mode: 'HTML' }
    );
  }
});

// ─── Business Messages (от пользователей) ────────────────────────────────────
bot.on('business_message', async (ctx) => {
  const msg  = ctx.update.business_message;
  const from = msg.from;
  if (!from || from.id === ADMIN_ID) return; // игнорируем свои сообщения

  const userId   = from.id;
  const chatId   = msg.chat.id;
  const bizConnId = msg.business_connection_id;
  const text      = msg.text ?? msg.caption ?? '';

  // ── /disable ──────────────────────────────────────────────────────────────
  if (/^\/disable(@\S+)?$/i.test(text.trim())) {
    disableUser(userId, chatId, from.first_name);

    await sendBusiness(ctx, chatId, bizConnId,
      `<tg-emoji emoji-id="5870657884844462243">❌</tg-emoji> <b>ИИ-помощник отключён.</b>\n\n` +
      `<tg-emoji emoji-id="5870772616305839506">👥</tg-emoji> Ваш запрос передан оператору, ` +
      `мы ответим в ближайшее время!\n\n` +
      `<tg-emoji emoji-id="6028435952299413210">ℹ️</tg-emoji> Чтобы снова включить ИИ, напишите /enable`
    );

    // Уведомить админа
    await ctx.telegram.sendMessage(
      ADMIN_ID,
      `<tg-emoji emoji-id="6039422865189638057">📣</tg-emoji> <b>Пользователь отключил ИИ!</b>\n\n` +
      `<tg-emoji emoji-id="5870994129244131212">👤</tg-emoji> <b>${from.first_name ?? '—'}</b> ` +
      `(<code>${userId}</code>)\n\n` +
      `<tg-emoji emoji-id="5870753782874246579">✍️</tg-emoji> Требуется ответ оператора.`,
      { parse_mode: 'HTML' }
    );
    return;
  }

  // ── /enable ───────────────────────────────────────────────────────────────
  if (/^\/enable(@\S+)?$/i.test(text.trim())) {
    enableUser(userId);

    await sendBusiness(ctx, chatId, bizConnId,
      `<tg-emoji emoji-id="5870633910337015697">✅</tg-emoji> <b>ИИ-помощник включён!</b>\n\n` +
      `<tg-emoji emoji-id="6030400221232501136">🤖</tg-emoji> Задайте ваш вопрос — я постараюсь помочь.`
    );
    return;
  }

  // ── Если ИИ отключён — молчим ─────────────────────────────────────────────
  if (isDisabled(userId)) return;

  // ── Нет текста (стикер, медиа без caption) ────────────────────────────────
  if (!text) return;

  // ── Индикатор набора (через прямой Bot API вызов, Telegraf не прокидывает business_connection_id в sendChatAction) ──
  try {
    await ctx.telegram.callApi('sendChatAction', {
      chat_id: chatId,
      action: 'typing',
      business_connection_id: bizConnId,
    });
  } catch (_) { /* не критично */ }

  // ── Запрос к ИИ ──────────────────────────────────────────────────────────
  try {
    addMessage(userId, 'user', text);
    const answer = await fetchAIResponse(userId, text);
    addMessage(userId, 'assistant', answer);

    await sendBusiness(ctx, chatId, bizConnId,
      `<tg-emoji emoji-id="6030400221232501136">🤖</tg-emoji> ${escapeHtml(answer)}\n\n` +
      `<i><tg-emoji emoji-id="6028435952299413210">ℹ️</tg-emoji> Не помогло? Напишите /disable для связи с оператором.</i>`
    );
  } catch (err) {
    const errData = err?.response?.data ?? err?.message ?? String(err);
    console.error('[AI error]', errData);

    // Проверяем — если ошибка в авторизации OnlySq, не спамим пользователя
    const isAuthError = err?.response?.status === 401 ||
      String(errData).toLowerCase().includes('api key') ||
      String(errData).toLowerCase().includes('authentication');

    if (isAuthError) {
      // Уведомляем только админа
      await ctx.telegram.sendMessage(
        ADMIN_ID,
        `<tg-emoji emoji-id="5870657884844462243">❌</tg-emoji> <b>Ошибка авторизации OnlySq!</b>\n\n` +
        `Проверьте <code>ONLYSQ_API_KEY</code> в файле <code>.env</code>\n` +
        `Получить ключ: https://my.onlysq.ru`,
        { parse_mode: 'HTML' }
      ).catch(() => {});
      return;
    }

    // Для прочих ошибок — сообщаем пользователю
    await sendBusiness(ctx, chatId, bizConnId,
      `<tg-emoji emoji-id="5870657884844462243">❌</tg-emoji> <b>Не удалось получить ответ.</b>\n\n` +
      `Попробуйте ещё раз или напишите /disable для связи с оператором.`
    ).catch((e) => console.error('[sendBusiness error]', e.message));
  }
});

// ─── Helpers ─────────────────────────────────────────────────────────────────
async function sendBusiness(ctx, chatId, bizConnId, html) {
  return ctx.telegram.sendMessage(chatId, html, {
    parse_mode: 'HTML',
    business_connection_id: bizConnId,
  });
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

// Рекурсивно собирает строки из произвольного JSON-объекта (для парсинга моделей)
function extractStrings(obj, depth = 0) {
  if (depth > 4) return [];
  if (typeof obj === 'string') return [obj];
  if (Array.isArray(obj)) return obj.flatMap((v) => extractStrings(v, depth + 1));
  if (obj && typeof obj === 'object') {
    // Приоритет: поля id, name, model
    const priority = ['id', 'name', 'model'];
    const result = [];
    for (const key of priority) {
      if (typeof obj[key] === 'string') result.push(obj[key]);
    }
    if (result.length) return result;
    return Object.values(obj).flatMap((v) => extractStrings(v, depth + 1));
  }
  return [];
}

// ─── Launch ───────────────────────────────────────────────────────────────────

// Глобальный перехват ошибок — чтобы бот не крашился на необработанных апдейтах
bot.catch((err, ctx) => {
  const code    = err?.response?.error_code ?? err?.status ?? '—';
  const desc    = err?.response?.description ?? err?.message ?? String(err);
  console.error(`[bot.catch] ${code}: ${desc}`, ctx?.updateType ?? '');
});

bot.launch({
  allowedUpdates: [
    'message',
    'callback_query',
    'business_connection',
    'business_message',
    'edited_business_message',
    'deleted_business_messages',
  ],
}).then(() => {
  console.log('🤖  Dreinn VPN Bot запущен');
  console.log(`👤  Админ: ${ADMIN_ID}`);
  console.log(`🧠  Модель: ${getSetting('model')}`);
}).catch((e) => {
  console.error('Ошибка запуска:', e.message);
  process.exit(1);
});

process.once('SIGINT',  () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
