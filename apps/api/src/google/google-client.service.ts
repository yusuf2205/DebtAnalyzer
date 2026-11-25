import { Injectable, UnprocessableEntityException } from '@nestjs/common';
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { SHEETS_FIELDS, sheetsApiToSheetData } from '@pf/shared/import';
import type { SheetData } from '@pf/shared/import';
import { loadConfig } from '../config';

export const SCOPES = 'openid email https://www.googleapis.com/auth/spreadsheets.readonly';
const MAX_BYTES = 25 * 1024 * 1024;

export class GoogleAccessError extends UnprocessableEntityException {
  constructor(message: string) { super({ message, code: 'GOOGLE_ACCESS_REQUIRED' }); }
}

/** Принимаем только ссылки docs.google.com/spreadsheets/d/<id>: произвольные адреса недопустимы (защита от SSRF). */
export function parseSpreadsheetUrl(input: string): { id: string; gid: string | null } {
  let u: URL;
  try { u = new URL(input.trim()); } catch { throw new UnprocessableEntityException('Это не ссылка. Вставьте адрес таблицы вида https://docs.google.com/spreadsheets/d/…'); }
  const m = /^\/spreadsheets\/(?:u\/\d+\/)?d\/([\w-]{20,100})(?:\/|$)/.exec(u.pathname);
  if (u.protocol !== 'https:' || u.hostname !== 'docs.google.com' || !m) {
    throw new UnprocessableEntityException('Нужна ссылка на Google Таблицу: https://docs.google.com/spreadsheets/d/…');
  }
  const gid = /[#&?]gid=(\d+)/.exec(u.hash + u.search)?.[1] ?? null;
  return { id: m[1], gid };
}

// ---- Шифрование refresh-токенов (AES-256-GCM). Ключ — только из окружения, в БД и Git его нет ----
const key = () => {
  const k = loadConfig().TOKEN_ENCRYPTION_KEY;
  if (!k) throw new UnprocessableEntityException('На сервере не задан TOKEN_ENCRYPTION_KEY — подключение Google-аккаунта недоступно');
  return createHash('sha256').update(k).digest();
};
export function encryptSecret(plain: string): string {
  const iv = randomBytes(12), c = createCipheriv('aes-256-gcm', key(), iv);
  const ct = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), ct]).toString('base64');
}
export function decryptSecret(enc: string): string {
  const b = Buffer.from(enc, 'base64');
  const d = createDecipheriv('aes-256-gcm', key(), b.subarray(0, 12));
  d.setAuthTag(b.subarray(12, 28));
  return Buffer.concat([d.update(b.subarray(28)), d.final()]).toString('utf8');
}

@Injectable()
export class GoogleClient {
  private cfg = () => loadConfig();

  private allowedHost(h: string) {
    const t = this.cfg().NODE_ENV === 'test';
    return h === 'docs.google.com' || h.endsWith('.google.com') || h.endsWith('.googleusercontent.com') || (t && (h === 'localhost' || h === '127.0.0.1'));
  }

  /** Публичная таблица («Все, у кого есть ссылка»): скачиваем XLSX-экспорт. Без ключей и без входа в аккаунт. */
  async fetchPublicXlsx(id: string): Promise<Buffer> {
    let url = `${this.cfg().google.docsBase}/spreadsheets/d/${id}/export?format=xlsx`;
    for (let hop = 0; hop < 6; hop++) {
      let res: Response;
      try { res = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(60_000), headers: { 'user-agent': 'ProcurementFinance/1.0' } }); }
      catch { throw new UnprocessableEntityException('Не удалось связаться с Google. Проверьте подключение сервера к интернету.'); }
      if (res.status >= 300 && res.status < 400) {
        const next = new URL(res.headers.get('location') ?? '', url);
        if (!this.allowedHost(next.hostname)) throw new UnprocessableEntityException('Google вернул недопустимое перенаправление');
        url = next.href; continue;
      }
      if (res.status === 404) throw new UnprocessableEntityException('Таблица не найдена — проверьте ссылку');
      const ct = res.headers.get('content-type') ?? '';
      if (res.status !== 200 || ct.includes('text/html')) {
        throw new GoogleAccessError('Таблица закрыта. Откройте доступ «Все, у кого есть ссылка → Читатель» или подключите Google-аккаунт, у которого есть доступ.');
      }
      const len = Number(res.headers.get('content-length') ?? 0);
      if (len > MAX_BYTES) throw new UnprocessableEntityException('Таблица слишком большая (более 25 МБ)');
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length > MAX_BYTES) throw new UnprocessableEntityException('Таблица слишком большая (более 25 МБ)');
      if (!(buf[0] === 0x50 && buf[1] === 0x4b)) throw new GoogleAccessError('Google вернул не таблицу — вероятно, доступ закрыт.');
      return buf;
    }
    throw new UnprocessableEntityException('Слишком много перенаправлений при загрузке таблицы');
  }

  // ---- OAuth ----
  authUrl(state: string): string {
    const c = this.cfg(), g = c.google;
    if (!g.oauthConfigured) throw new UnprocessableEntityException('Вход через Google не настроен на сервере (GOOGLE_CLIENT_ID/SECRET/REDIRECT_URI, TOKEN_ENCRYPTION_KEY)');
    const p = new URLSearchParams({ client_id: c.GOOGLE_CLIENT_ID!, redirect_uri: c.GOOGLE_REDIRECT_URI!, response_type: 'code', scope: SCOPES, access_type: 'offline', prompt: 'consent', state });
    return `${g.authUrl}?${p}`;
  }

  private async token(body: Record<string, string>) {
    const c = this.cfg();
    const res = await fetch(c.google.tokenUrl, {
      method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, signal: AbortSignal.timeout(30_000),
      body: new URLSearchParams({ client_id: c.GOOGLE_CLIENT_ID!, client_secret: c.GOOGLE_CLIENT_SECRET!, ...body }),
    });
    const json: any = await res.json().catch(() => ({}));
    if (!res.ok) throw new GoogleAccessError(json?.error === 'invalid_grant' ? 'Доступ Google отозван или истёк — подключите аккаунт заново.' : `Google отклонил запрос (${json?.error ?? res.status})`);
    return json as { access_token: string; refresh_token?: string; id_token?: string; scope?: string };
  }

  async exchangeCode(code: string) {
    const t = await this.token({ grant_type: 'authorization_code', code, redirect_uri: this.cfg().GOOGLE_REDIRECT_URI! });
    if (!t.refresh_token) throw new UnprocessableEntityException('Google не выдал долгосрочный доступ. Отзовите доступ приложения в аккаунте Google и подключитесь снова.');
    let email: string | null = null;
    try { email = JSON.parse(Buffer.from((t.id_token ?? '').split('.')[1] ?? '', 'base64url').toString('utf8')).email ?? null; } catch { /* email необязателен */ }
    if (!(t.scope ?? SCOPES).includes('spreadsheets.readonly')) throw new UnprocessableEntityException('Не выдано разрешение на чтение таблиц');
    return { refreshToken: t.refresh_token, email, scope: t.scope ?? SCOPES };
  }

  accessToken(refreshTokenEnc: string) {
    return this.token({ grant_type: 'refresh_token', refresh_token: decryptSecret(refreshTokenEnc) }).then((t) => t.access_token);
  }

  /** Чтение через Sheets API (права только на чтение). Возвращает листы в той же модели, что и XLSX. */
  async fetchViaApi(id: string, accessToken: string): Promise<{ title: string; sheets: SheetData[] }> {
    const url = `${this.cfg().google.apiBase}/v4/spreadsheets/${id}?includeGridData=true&fields=${encodeURIComponent(SHEETS_FIELDS)}`;
    let res: Response;
    try { res = await fetch(url, { headers: { authorization: `Bearer ${accessToken}` }, signal: AbortSignal.timeout(90_000) }); }
    catch { throw new UnprocessableEntityException('Не удалось связаться с Google Sheets API'); }
    if (res.status === 401 || res.status === 403) throw new GoogleAccessError('У подключённого Google-аккаунта нет доступа к этой таблице.');
    if (res.status === 404) throw new UnprocessableEntityException('Таблица не найдена — проверьте ссылку');
    if (!res.ok) throw new UnprocessableEntityException(`Google Sheets API вернул ошибку ${res.status}`);
    return sheetsApiToSheetData(await res.json());
  }
}
