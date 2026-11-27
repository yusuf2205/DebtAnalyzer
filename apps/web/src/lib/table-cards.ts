/**
 * На телефоне таблицы показываются карточками (см. globals.css): у каждой ячейки должна быть подпись столбца.
 * Подписи проставляются один раз из заголовка таблицы — так не нужно менять разметку каждой страницы.
 * Таблицы-сетки (календарь по неделям) помечаются классом tbl-keep и остаются таблицами с прокруткой.
 */
export function labelTables(root: ParentNode) {
  root.querySelectorAll<HTMLTableElement>('table.tbl:not(.tbl-keep)').forEach((t) => {
    const heads = Array.from(t.tHead?.rows[0]?.cells ?? []).map((th) => (th.textContent ?? '').replace(/[↑↓▲▼]/g, '').replace(/\s+/g, ' ').trim());
    if (!heads.length) return;
    for (const body of Array.from(t.tBodies)) {
      for (const tr of Array.from(body.rows)) {
        let col = 0;
        for (const td of Array.from(tr.cells)) {
          if (td.colSpan > 1) { col += td.colSpan; continue; } // «Ничего не найдено» и подобные — без подписи
          const label = heads[col] ?? '';
          if (td.dataset.label !== label) td.dataset.label = label;
          col += 1;
        }
      }
    }
  });
}
