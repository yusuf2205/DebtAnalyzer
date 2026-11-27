'use client';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { api, money } from './api';
import { PeekShell, Row, Tile } from './peek-shell';
import { useSession } from './session';
import { OriginBadge, PAY_KIND, PayBadge, StateBadge } from './ui';

const MONTHS = ['янв', 'фев', 'мар', 'апр', 'май', 'июн', 'июл', 'авг', 'сен', 'окт', 'ноя', 'дек'];
const num = (v: any) => Number(v ?? 0);
const dt = (v: string) => new Date(v).toLocaleDateString('ru-RU');

/**
 * Краткая панель договора справа: главное без перехода на отдельную страницу.
 * Не модальная на компьютере: список остаётся доступен, клик по другому договору переключает панель; Esc или крестик закрывают.
 * На телефоне занимает весь экран.
 */
export function ContractPeek({ id, onClose }: { id: string; onClose: () => void }) {
  const { can } = useSession();
  const [c, setC] = useState<any>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    let alive = true;
    setC(null); setError('');
    api('GET', `/contracts/${id}`).then((r) => alive && setC(r)).catch((e) => alive && setError(e.message));
    return () => { alive = false; };
  }, [id]);

  const plans: any[] = c ? [...c.plans].sort((a, b) => a.year - b.year || a.month - b.month || a.week - b.week) : [];
  const payments: any[] = c?.payments ?? [];

  return (
    <PeekShell label="Краткая карточка договора" focusKey={id} onClose={onClose}
      title={<>{c ? (c.number ?? 'Без номера') : 'Загрузка…'}{c?.status === 'ARCHIVED' && <span className="badge b-mute ml-2">архив</span>}</>}
      subtitle={c && <><Link className="underline" href={`/suppliers/${c.supplier.id}`}>{c.supplier.name}</Link>{c.project && <> · {c.project}</>}{c.contractDate && <> · от {dt(c.contractDate)}</>}</>}>
        {error && <p role="alert" className="b-err px-4">{error}</p>}
        {c && (
          <div className="px-4 pb-4 space-y-4 overflow-y-auto">
            <div className="flex items-center gap-2 flex-wrap"><StateBadge state={c.state} /><span className="muted text-xs">{c.currency}</span><OriginBadge c={c} /></div>

            <div className="grid grid-cols-2 gap-2">
              <Tile label="Сумма договора" value={money(c.amount)} unit={c.currency} />
              <Tile label="Оплачено" value={money(c.paid)} unit={c.currency} tone="b-ok" />
              <Tile label="Остаток долга" value={num(c.debt) ? money(c.debt) : '—'} unit={num(c.debt) ? c.currency : ''} tone="b-err" />
              <Tile label={num(c.overpaid) ? 'Переплата' : 'План (всего)'} value={num(c.overpaid) ? money(c.overpaid) : num(c.planned) ? money(c.planned) : '—'} unit={num(c.overpaid) || num(c.planned) ? c.currency : ''} tone="b-info" />
            </div>

            <dl className="text-sm space-y-1">
              <Row k="Товар" v={c.goods} /><Row k="Исполнитель" v={c.executor} /><Row k="Примечание" v={c.notes} />
              <Row k="Документов" v={String(c.documents.length)} />
            </dl>

            <section>
              <h3 className="text-sm font-semibold b-info">План платежей</h3>
              {plans.length === 0 ? <p className="muted text-sm">План не задан.</p> : (
                <ul className="text-sm">{plans.slice(-4).map((p) => <li key={p.id} className="flex justify-between gap-3 py-0.5"><span className="muted">{MONTHS[p.month - 1]} {p.year}, W{p.week}</span><span className="tabular-nums">{money(p.amount, p.currency)}</span></li>)}</ul>)}
              {plans.length > 4 && <p className="muted text-xs">Показаны последние 4 из {plans.length}.</p>}
            </section>

            <section>
              <h3 className="text-sm font-semibold b-ok">Последние платежи ({payments.length})</h3>
              {payments.length === 0 ? <p className="muted text-sm">Платежей в приложении нет.</p> : (
                <ul className="text-sm">{payments.slice(0, 5).map((p) => (
                  <li key={p.id} className="flex items-center justify-between gap-3 py-1">
                    <span className="min-w-0"><Link className="underline" href={`/payments/${p.id}`}>{dt(p.paymentDate)}</Link> <span className="muted text-xs">{PAY_KIND[p.kind]}</span> <PayBadge status={p.status} /></span>
                    <span className={`tabular-nums shrink-0 ${p.kind === 'PAYMENT' ? 'b-ok' : 'b-err'}`}>{money(p.amount, p.currency)}</span></li>))}</ul>)}
              {c.reconciliation.length > 0 && <p className="text-xs b-warn mt-1">Есть расхождения со сверкой: {c.reconciliation.length}. <Link className="underline" href="/reconciliation">Открыть сверку</Link></p>}
            </section>

            <div className="flex gap-2 flex-wrap pt-1">
              <Link href={`/contracts/${id}`} className="btn btn-primary">Открыть полностью</Link>
              {can('payments.create') && c.status !== 'ARCHIVED' && <Link href={`/payments/new?contractId=${id}`} className="btn">Добавить платёж</Link>}
              {can('plans.view') && <Link href={`/calendar?contractId=${id}`} className="btn">В календаре</Link>}
            </div>
          </div>)}
    </PeekShell>
  );
}
