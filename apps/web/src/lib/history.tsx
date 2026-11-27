'use client';
import { money } from './api';

const ACTIONS: Record<string, string> = {
  'contract.create': 'Договор создан', 'contract.update': 'Договор изменён', 'contract.update_financial': 'Изменены сумма или валюта', 'contract.archive': 'Отправлен в архив', 'contract.restore': 'Восстановлен из архива',
  'contract.document_add': 'Добавлен документ', 'contract.document_remove': 'Удалён документ',
  'plan.create': 'Создан плановый платёж', 'plan.update': 'План изменён', 'plan.move': 'План перенесён', 'plan.split': 'План разделён', 'plan.delete': 'План удалён',
  'payment.create': 'Платёж создан', 'payment.update': 'Платёж изменён', 'payment.submit': 'Отправлен на подтверждение', 'payment.approve': 'Платёж подтверждён', 'payment.reject': 'Платёж отклонён',
  'payment.cancel': 'Платёж отменён', 'payment.reverse': 'Платёж сторнирован', 'payment.correct': 'Платёж исправлен', 'payment.document_add': 'Добавлен документ', 'payment.document_remove': 'Удалён документ',
  'reconciliation.match': 'Сопоставлено со сверкой', 'reconciliation.confirm': 'Сверка применена', 'reconciliation.reject': 'Расхождение отклонено',
  'supplier.create': 'Контрагент создан', 'supplier.update': 'Контрагент изменён', 'supplier.merge': 'Контрагенты объединены', 'supplier.alias_add': 'Добавлено написание названия', 'supplier.alias_remove': 'Удалено написание названия',
  'import.commit': 'Загружено из таблицы',
};
const FIELDS: Record<string, string> = {
  number: 'Номер', amount: 'Сумма', currency: 'Валюта', executor: 'Исполнитель', project: 'Проект', goods: 'Товар', notes: 'Примечание', origin: 'Тип', status: 'Статус', contractDate: 'Дата договора',
  name: 'Название', taxId: 'ИНН', paymentDate: 'Дата платежа', bankDocument: 'Банковский документ', transactionNo: 'Номер транзакции', comment: 'Комментарий',
};
const VALUES: Record<string, Record<string, string>> = {
  origin: { LOCAL: 'местный', FOREIGN: 'зарубежный' }, status: { ACTIVE: 'активен', ARCHIVED: 'в архиве', DRAFT: 'черновик', PENDING: 'ждёт подтверждения', APPROVED: 'подтверждён', REJECTED: 'отклонён', CANCELLED: 'отменён' },
};
const fmt = (k: string, v: unknown) => {
  if (v === null || v === undefined || v === '') return '—';
  if (VALUES[k]?.[String(v)]) return VALUES[k]![String(v)]!;
  if (k === 'amount' && !isNaN(Number(v))) return money(String(v));
  return String(v).length > 80 ? `${String(v).slice(0, 80)}…` : String(v);
};

/** Что изменилось: пары «поле: было → стало» только по известным полям и только там, где значение действительно отличается. */
function changes(h: any): string[] {
  const b = (h.before && typeof h.before === 'object' ? h.before : {}) as Record<string, unknown>;
  const a = (h.after && typeof h.after === 'object' ? h.after : {}) as Record<string, unknown>;
  const out: string[] = [];
  for (const k of Object.keys(FIELDS)) {
    if (!(k in a) && !(k in b)) continue;
    const x = fmt(k, b[k]), y = fmt(k, a[k]);
    if (x !== y) out.push(`${FIELDS[k]}: ${x} → ${y}`);
  }
  return out;
}

/** Человекочитаемый журнал: время, кто, что сделал, что изменилось и причина. Технические записи показываются кодом действия. */
export function HistoryList({ items, empty = 'Записей нет' }: { items: any[]; empty?: string }) {
  if (!items.length) return <p className="muted text-sm">{empty}</p>;
  return (
    <ul className="text-sm space-y-2">
      {items.map((h) => {
        const ch = changes(h);
        const reason = h.meta?.reason as string | undefined;
        return (
          <li key={h.id}>
            <div><b>{ACTIONS[h.action] ?? h.action}</b>{h.meta?.bulk && <span className="badge b-mute ml-2">массово</span>}{h.meta?.acceptedSuggestion && <span className="badge b-info ml-1">по предложению системы</span>}</div>
            <div className="muted text-xs">{new Date(h.at).toLocaleString('ru-RU')} · {h.userEmail ?? 'система'}</div>
            {ch.length > 0 && <ul className="text-xs mt-0.5 space-y-0.5">{ch.map((c, i) => <li key={i}>{c}</li>)}</ul>}
            {reason && <div className="text-xs mt-0.5"><span className="muted">Причина:</span> {reason}</div>}
          </li>);
      })}
    </ul>
  );
}
