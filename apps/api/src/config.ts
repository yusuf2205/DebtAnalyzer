import { z } from 'zod';

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().default(4000),
  DATABASE_URL: z.string().min(1),
  UPLOAD_DIR: z.string().default('./uploads'),
  SESSION_TTL_HOURS: z.coerce.number().default(12),
  COOKIE_SECURE: z.enum(['true', 'false']).optional(),
  INITIAL_ADMIN_EMAIL: z.string().email().optional(),
  INITIAL_ADMIN_PASSWORD: z.string().min(4).optional(),
  MAX_UPLOAD_MB: z.coerce.number().default(25),
  // Google OAuth (нужен только для закрытых таблиц; публичные ссылки работают без него)
  GOOGLE_CLIENT_ID: z.string().optional(),
  GOOGLE_CLIENT_SECRET: z.string().optional(),
  GOOGLE_REDIRECT_URI: z.string().url().optional(),
  TOKEN_ENCRYPTION_KEY: z.string().min(32).optional(),
  // Переопределение адресов Google — действует ТОЛЬКО при NODE_ENV=test (для тестов с имитацией Google).
  GOOGLE_DOCS_BASE: z.string().optional(),
  GOOGLE_API_BASE: z.string().optional(),
  GOOGLE_TOKEN_URL: z.string().optional(),
  GOOGLE_AUTH_URL: z.string().optional(),
  /** Сколько прокси стоит перед API (Cloudflare Tunnel -> web -> api = 2). От этого зависят req.ip, лимиты запросов и IP в аудите. */
  TRUST_PROXY_HOPS: z.coerce.number().int().min(0).max(5).default(1),
  /** Каталог резервных копий, смонтированный в API только для чтения (страница «Система»). */
  BACKUP_DIR: z.string().optional(),
  LOGIN_RATE_LIMIT: z.coerce.number().default(10),
  // Уведомления (необязательны): Telegram-бот и/или SMTP. Получатели и расписание — в настройках приложения («Уведомления»).
  TELEGRAM_BOT_TOKEN: z.string().optional(),
  TELEGRAM_API_BASE: z.string().optional(), // только при NODE_ENV=test
  SMTP_HOST: z.string().optional(),
  SMTP_PORT: z.coerce.number().default(587),
  SMTP_USER: z.string().optional(),
  SMTP_PASS: z.string().optional(),
  SMTP_FROM: z.string().optional(),
  SMTP_SECURE: z.enum(['true', 'false']).default('false'),
  CBU_URL: z.string().optional(), // только при NODE_ENV=test (имитация ЦБ)
  /** Часовой пояс расписания уведомлений. */
  APP_TIMEZONE: z.string().default('Asia/Tashkent'),
  /** Публичный адрес приложения (для ссылок в сообщениях). */
  APP_BASE_URL: z.string().url().optional(),
});

export type Config = z.infer<typeof schema> & {
  cookieSecure: boolean;
  google: { docsBase: string; apiBase: string; tokenUrl: string; authUrl: string; oauthConfigured: boolean };
};

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  // Docker Compose передаёт незаданные переменные пустыми строками (`${VAR:-}`): пустое значение = «не задано»
  const cleaned = Object.fromEntries(Object.entries(env).filter(([, v]) => v !== ''));
  const parsed = schema.safeParse(cleaned);
  if (!parsed.success) throw new Error('Некорректная конфигурация окружения: ' + parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '));
  const c = parsed.data;
  const t = c.NODE_ENV === 'test';
  const google = {
    docsBase: (t && c.GOOGLE_DOCS_BASE) || 'https://docs.google.com',
    apiBase: (t && c.GOOGLE_API_BASE) || 'https://sheets.googleapis.com',
    tokenUrl: (t && c.GOOGLE_TOKEN_URL) || 'https://oauth2.googleapis.com/token',
    authUrl: (t && c.GOOGLE_AUTH_URL) || 'https://accounts.google.com/o/oauth2/v2/auth',
    oauthConfigured: !!(c.GOOGLE_CLIENT_ID && c.GOOGLE_CLIENT_SECRET && c.GOOGLE_REDIRECT_URI && c.TOKEN_ENCRYPTION_KEY),
  };
  return { ...c, google, cookieSecure: c.COOKIE_SECURE ? c.COOKIE_SECURE === 'true' : c.NODE_ENV === 'production' };
}
