import nodemailer from 'nodemailer';
import type { Config } from '../config';

/** Сообщения, «отправленные» в тестовом окружении (SMTP_HOST=test:json): письма не уходят наружу, а попадают сюда. */
export const testOutbox: { to: string; subject: string; text: string }[] = [];

export const telegramConfigured = (c: Config) => !!c.TELEGRAM_BOT_TOKEN;
export const emailConfigured = (c: Config) => !!(c.SMTP_HOST && c.SMTP_FROM);

export async function sendTelegram(c: Config, chatId: string, text: string): Promise<void> {
  const base = (c.NODE_ENV === 'test' && c.TELEGRAM_API_BASE) || 'https://api.telegram.org';
  const r = await fetch(`${base}/bot${c.TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text: text.slice(0, 4000), disable_web_page_preview: true }), signal: AbortSignal.timeout(15_000),
  });
  const j = (await r.json().catch(() => null)) as { ok?: boolean; description?: string } | null;
  if (!r.ok || !j?.ok) throw new Error(`Telegram (${chatId}): ${j?.description ?? `HTTP ${r.status}`}`);
}

export async function sendEmail(c: Config, to: string, subject: string, text: string): Promise<void> {
  if (c.NODE_ENV === 'test' && c.SMTP_HOST === 'test:json') { testOutbox.push({ to, subject, text }); return; }
  const transport = nodemailer.createTransport({
    host: c.SMTP_HOST, port: c.SMTP_PORT, secure: c.SMTP_SECURE === 'true',
    ...(c.SMTP_USER ? { auth: { user: c.SMTP_USER, pass: c.SMTP_PASS } } : {}), connectionTimeout: 15_000, socketTimeout: 20_000,
  });
  try { await transport.sendMail({ from: c.SMTP_FROM, to, subject, text }); }
  catch (e) { throw new Error(`Почта (${to}): ${(e as Error).message}`); }
}
