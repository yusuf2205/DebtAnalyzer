export interface Me { id: string; email: string; name: string; role: 'SUPER_ADMIN' | 'ADMIN' | 'FINANCE' | 'MANAGER' | 'VIEWER'; customRole: { id: string; name: string } | null; permissions: string[]; mustChangePassword: boolean; csrfToken: string }

let csrf = '';
export const setCsrf = (t: string) => { csrf = t; };

export class ApiError extends Error {
  constructor(public status: number, message: string, public code?: string) { super(message); }
}

export async function api<T = any>(method: string, url: string, body?: unknown): Promise<T> {
  const isForm = typeof FormData !== 'undefined' && body instanceof FormData;
  const res = await fetch(`/api${url}`, {
    method, credentials: 'same-origin',
    headers: { ...(method !== 'GET' && csrf ? { 'x-csrf-token': csrf } : {}), ...(body && !isForm ? { 'content-type': 'application/json' } : {}) },
    body: body ? (isForm ? (body as FormData) : JSON.stringify(body)) : undefined,
  });
  if (res.status === 204) return undefined as T;
  const text = await res.text();
  let json: any; try { json = text ? JSON.parse(text) : undefined; } catch { json = undefined; }
  if (!res.ok) {
    const msg = Array.isArray(json?.message) ? json.message.join('; ') : json?.message ?? `Ошибка ${res.status}`;
    throw new ApiError(res.status, msg + (json?.issues ? ': ' + json.issues.map((i: any) => `${i.path} ${i.message}`).join(', ') : ''), json?.code);
  }
  return json as T;
}

export const money = (v: string | number | null | undefined, cur?: string) => {
  if (v === null || v === undefined || v === '') return '—';
  const n = Number(v);
  const s = n.toLocaleString('ru-RU', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return cur ? `${s} ${cur}` : s;
};
