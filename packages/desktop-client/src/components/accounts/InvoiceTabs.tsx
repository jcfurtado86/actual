import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import type { Ref } from 'react';
import { useTranslation } from 'react-i18next';

import { Button } from '@actual-app/components/button';
import { Select } from '@actual-app/components/select';
import { Text } from '@actual-app/components/text';
import { theme } from '@actual-app/components/theme';
import { View } from '@actual-app/components/view';
import { listen, send } from '@actual-app/core/platform/client/connection';
import { q } from '@actual-app/core/shared/query';
import type { TransactionEntity } from '@actual-app/core/types/models';

import { useSyncedPref } from '#hooks/useSyncedPref';
import { aqlQuery } from '#queries/aqlQuery';

const DEFAULT_CLOSING_DAY = 24;
const MAX_PAST_INVOICES = 36;

const MONTH_SHORT = [
  'jan',
  'fev',
  'mar',
  'abr',
  'mai',
  'jun',
  'jul',
  'ago',
  'set',
  'out',
  'nov',
  'dez',
];

type InvoicePeriod = {
  key: string; // "YYYY-MM" of the closing month
  label: string;
  from: string;
  to: string;
  /** Whether the close date is overridden by the user. */
  overridden: boolean;
};

type FutureProjection = {
  byKey: Map<string, number>;
  /** Synthetic transactions to be rendered by TransactionsTable. */
  occurrencesByKey: Map<string, TransactionEntity[]>;
  maxKey: string | null;
};

// Strict parcelada detector. Iterates ALL X/Y candidates in the text and
// returns the first VALID one. Validation:
//   - 1 <= current <= total
//   - 2 <= total <= 24
//   - If total > 12 → unambiguous (no month has 13+).
//   - If total <= 12 → require "parc"/"parcela" within 30 chars BEFORE the
//     X/Y match. This avoids false positives like dates in notes
//     ("ENTREGA 02/04/26") that previously bumped the parcela detection.
function parseParcelInfo(
  text: string | null | undefined,
): { current: number; total: number } | null {
  if (!text) return null;
  const candidates = [...text.matchAll(/\b(\d{1,2})\s*\/\s*(\d{1,2})\b/g)];
  for (const m of candidates) {
    const current = Number(m[1]);
    const total = Number(m[2]);
    if (!Number.isFinite(current) || !Number.isFinite(total)) continue;
    if (current < 1 || total < 2 || total > 24 || current > total) continue;
    if (total > 12) return { current, total };
    const startIdx = m.index ?? 0;
    const context = text.slice(Math.max(0, startIdx - 30), startIdx);
    if (/\bparc/i.test(context)) return { current, total };
  }
  return null;
}

function isParceladaText(text: string | null | undefined): boolean {
  return parseParcelInfo(text) !== null;
}

// Canonical form of transaction notes — used as the identity key when
// grouping parcelas and deduping synth vs real. Payee fields are often null
// (Pluggy doesn't normalize them), so the notes title is the only reliable
// identifier. Strategy: take everything BEFORE the "PARC X/Y" pattern and
// upper-case it. For non-parcelada text, fall back to the trimmed whole.
function notesCanonical(text: string | null | undefined): string {
  if (!text) return '';
  const m = /^(.*?)\s*\bparc[\s.]*\d{1,2}\s*\/\s*\d{1,2}/i.exec(text);
  if (m && m[1]) return m[1].trim().toUpperCase();
  return text.trim().toUpperCase();
}

function ymd(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function parseYmd(s: string): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) return null;
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
}

function keyFor(year: number, monthIdx: number): string {
  return `${year}-${String(monthIdx + 1).padStart(2, '0')}`;
}

/** Shift a fatura key (YYYY-MM) by N months (positive or negative). */
function shiftFaturaKey(fk: string, monthOffset: number): string | null {
  const m = /^(\d{4})-(\d{2})$/.exec(fk);
  if (!m) return null;
  let year = Number(m[1]);
  let monthIdx = Number(m[2]) - 1 + monthOffset;
  while (monthIdx < 0) {
    monthIdx += 12;
    year -= 1;
  }
  while (monthIdx > 11) {
    monthIdx -= 12;
    year += 1;
  }
  return keyFor(year, monthIdx);
}

function clampDay(year: number, monthIdx: number, day: number): Date {
  const lastDay = new Date(year, monthIdx + 1, 0).getDate();
  return new Date(year, monthIdx, Math.min(day, lastDay));
}

type ClosingsMap = Record<string, string>;

function parseClosings(raw: string | undefined): ClosingsMap {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    return typeof parsed === 'object' && parsed !== null ? parsed : {};
  } catch {
    return {};
  }
}

/**
 * Returns the date when the fatura labeled (labelYear, labelMonthIdx) CLOSES.
 * Convention: a fatura labeled "Out/25" closes the month BEFORE its label
 * (e.g., default day 24 → closes 2025-09-24). The label corresponds to when
 * the fatura is DUE, not when it closes.
 */
function getCloseDateFor(
  labelYear: number,
  labelMonthIdx: number,
  closingDay: number,
  overrides: ClosingsMap,
): Date {
  const labelKey = keyFor(labelYear, labelMonthIdx);
  if (overrides[labelKey]) {
    const d = parseYmd(overrides[labelKey]);
    if (d) return d;
  }
  const closeYear = labelMonthIdx === 0 ? labelYear - 1 : labelYear;
  const closeMonthIdx = labelMonthIdx === 0 ? 11 : labelMonthIdx - 1;
  return clampDay(closeYear, closeMonthIdx, closingDay);
}

/**
 * Given a transaction date, returns the LABEL key (YYYY-MM) of the fatura
 * whose period contains it.
 */
function faturaForDate(
  date: Date,
  closingDay: number,
  overrides: ClosingsMap,
): string | null {
  let y = date.getFullYear();
  let m = date.getMonth() + 1;
  if (m > 11) {
    m = 0;
    y += 1;
  }
  for (let i = 0; i < 36; i++) {
    const close = getCloseDateFor(y, m, closingDay, overrides);
    if (date <= close) return keyFor(y, m);
    m += 1;
    if (m > 11) {
      m = 0;
      y += 1;
    }
  }
  return null;
}

function computeInvoices(
  closingDay: number,
  overrides: ClosingsMap,
  oldestTxDate: string | null,
  futureMaxKey: string | null,
  today: Date = new Date(),
): {
  current: InvoicePeriod;
  past: InvoicePeriod[];
  future: InvoicePeriod[];
} {
  function build(labelYear: number, labelMonthIdx: number): InvoicePeriod {
    const closeDate = getCloseDateFor(
      labelYear,
      labelMonthIdx,
      closingDay,
      overrides,
    );
    const prevLabelYear = labelMonthIdx === 0 ? labelYear - 1 : labelYear;
    const prevLabelMonthIdx = labelMonthIdx === 0 ? 11 : labelMonthIdx - 1;
    const prevClose = getCloseDateFor(
      prevLabelYear,
      prevLabelMonthIdx,
      closingDay,
      overrides,
    );
    const fromDate = new Date(prevClose);
    fromDate.setDate(fromDate.getDate() + 1);
    return {
      key: keyFor(labelYear, labelMonthIdx),
      label: `${MONTH_SHORT[labelMonthIdx]}/${String(labelYear).slice(-2)}`,
      from: ymd(fromDate),
      to: ymd(closeDate),
      overridden: overrides[keyFor(labelYear, labelMonthIdx)] != null,
    };
  }

  // Find the "currently open" fatura: smallest label whose close date is in
  // the future. Walk forward month by month until we find one.
  let labelYear = today.getFullYear();
  let labelMonthIdx = today.getMonth();
  for (let i = 0; i < 24; i++) {
    const close = getCloseDateFor(
      labelYear,
      labelMonthIdx,
      closingDay,
      overrides,
    );
    if (close > today) break;
    labelMonthIdx += 1;
    if (labelMonthIdx > 11) {
      labelMonthIdx = 0;
      labelYear += 1;
    }
  }
  const current = build(labelYear, labelMonthIdx);

  const oldest = oldestTxDate ? parseYmd(oldestTxDate) : null;
  const past: InvoicePeriod[] = [];
  let m = labelMonthIdx - 1;
  let y = labelYear;
  for (let i = 0; i < MAX_PAST_INVOICES; i++) {
    if (m < 0) {
      m = 11;
      y -= 1;
    }
    const inv = build(y, m);
    if (oldest) {
      const invTo = parseYmd(inv.to);
      if (invTo && invTo < oldest) break;
    }
    past.push(inv);
    m -= 1;
  }

  // Future invoices: from current.key + 1 forward, up to futureMaxKey.
  const future: InvoicePeriod[] = [];
  if (futureMaxKey) {
    let fm = labelMonthIdx + 1;
    let fy = labelYear;
    if (fm > 11) {
      fm = 0;
      fy += 1;
    }
    for (let i = 0; i < 36; i++) {
      const inv = build(fy, fm);
      future.push(inv);
      if (inv.key === futureMaxKey) break;
      fm += 1;
      if (fm > 11) {
        fm = 0;
        fy += 1;
      }
    }
  }

  return { current, past, future };
}

type Props = {
  accountId: string;
  onSelectRange: (from: string | null, to: string | null) => void;
  onActiveTotalChange?: (total: number | null) => void;
  /**
   * Called when the active tab is a future invoice: provides the projected
   * synthetic transactions to be rendered by TransactionsTable instead of
   * real data. Called with null when leaving a future tab.
   */
  onFutureTransactionsChange?: (txs: TransactionEntity[] | null) => void;
};

export function InvoiceTabs({
  accountId,
  onSelectRange,
  onActiveTotalChange,
  onFutureTransactionsChange,
}: Props) {
  const { t } = useTranslation();
  const [closingDayValue, setClosingDayValue] = useSyncedPref(
    `closing-day-${accountId}`,
  );
  const [closingsValue, setClosingsValue] = useSyncedPref(
    `invoice-closings-${accountId}`,
  );
  const closingDay = Number(closingDayValue) || DEFAULT_CLOSING_DAY;
  const overrides = useMemo(
    () => parseClosings(closingsValue),
    [closingsValue],
  );
  const [activeKey, setActiveKey] = useState<string>('all');
  const [oldestTxDate, setOldestTxDate] = useState<string | null>(null);
  const [, setActiveTotal] = useState<number | null>(null);
  const [futureProjection, setFutureProjection] = useState<FutureProjection>({
    byKey: new Map(),
    occurrencesByKey: new Map(),
    maxKey: null,
  });
  const [summary, setSummary] = useState<{
    avista: { total: number; count: number };
    parcelada: { total: number; count: number };
  } | null>(null);
  // Bumped whenever the transactions table is mutated (sync, import, edit)
  // — used as a dep on the projection effect so it auto-refreshes.
  const [txTick, setTxTick] = useState(0);

  useEffect(() => {
    const unlisten = listen(
      'sync-event',
      (event: { type: string; tables?: string[] }) => {
        // eslint-disable-next-line no-console
        console.log('[sync-event]', event);
        // Any sync-event involving transactions or a full sync completion
        // bumps the tick. Being aggressive here is fine — projection is fast
        // and only re-runs if deps actually changed.
        if (
          (event.type === 'applied' &&
            event.tables?.includes('transactions')) ||
          event.type === 'success' ||
          event.type === 'unapplied'
        ) {
          setTxTick(t => t + 1);
        }
      },
    );
    return () => unlisten();
  }, []);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const { data } = await aqlQuery(
        q('transactions')
          .filter({ account: accountId })
          .orderBy({ date: 'asc' })
          .limit(1)
          .select(['date']),
      );
      if (cancelled) return;
      const first = (data || [])[0] as { date?: string } | undefined;
      setOldestTxDate(first?.date ?? null);
    })();
    return () => {
      cancelled = true;
    };
  }, [accountId]);

  // Build future projections:
  //   Pass 1: parceladas projected from REAL past transactions via the
  //   PARC X/Y regex — for each "group" (same payee+amount+total), take the
  //   most recent parcela and project the REMAINING ones forward.
  //   Pass 2: recurring schedules (unbounded only) project their upcoming
  //   occurrences, capped at the maxKey set by parceladas.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const byKey = new Map<string, number>();
      const occurrencesByKey = new Map<string, TransactionEntity[]>();
      // Wrapped in an object so TS preserves the `string | null` type after
      // mutations inside the pushSynth closure.
      const state: { maxKey: string | null } = { maxKey: null };
      let synthCounter = 0;

      // === Pass 1: parceladas via regex ===
      const { data: allTx } = await aqlQuery(
        q('transactions')
          .filter({
            account: accountId,
            is_parent: false,
            transfer_id: null,
            amount: { $lt: 0 },
          })
          .select(['date', 'amount', 'notes', 'payee', 'category']),
      );
      if (cancelled) return;

      // Group by (canonicalNotes, total) and merge by amount tolerance.
      // Identity comes from the notes title (Pluggy leaves payee null
      // often). Tolerance: ±100 cents (R$1) to absorb rounding noise
      // (Pluggy sometimes re-imports the same parcela with a few cents of
      // diff).
      const AMOUNT_TOLERANCE = 100;
      type Group = {
        date: string;
        amount: number;
        notes: string;
        canonical: string;
        payeeId?: string;
        categoryId?: string;
        current: number;
        total: number;
      };
      // Map<`canonical|total`, Group[]> — each list bucket holds groups
      // with distinct amounts (outside tolerance) for the same notes title
      // + total.
      const bucketsByCanonical = new Map<string, Group[]>();
      for (const t of (allTx || []) as Array<{
        date: string;
        amount: number;
        notes: string | null;
        payee: string | null;
        category: string | null;
      }>) {
        const parsed = parseParcelInfo(t.notes);
        if (!parsed) continue;
        const canonical = notesCanonical(t.notes);
        if (!canonical) continue;
        const bucketKey = `${canonical}|${parsed.total}`;
        let bucket = bucketsByCanonical.get(bucketKey);
        if (!bucket) {
          bucket = [];
          bucketsByCanonical.set(bucketKey, bucket);
        }
        const match = bucket.find(
          g => Math.abs(g.amount - t.amount) <= AMOUNT_TOLERANCE,
        );
        if (match) {
          if (parsed.current > match.current) {
            match.date = t.date;
            match.amount = t.amount;
            match.notes = t.notes || '';
            match.payeeId = t.payee ?? undefined;
            match.categoryId = t.category ?? undefined;
            match.current = parsed.current;
          }
        } else {
          bucket.push({
            date: t.date,
            amount: t.amount,
            notes: t.notes || '',
            canonical,
            payeeId: t.payee ?? undefined,
            categoryId: t.category ?? undefined,
            current: parsed.current,
            total: parsed.total,
          });
        }
      }
      const latestByGroup = new Map<string, Group>();
      for (const [bucketKey, bucket] of bucketsByCanonical) {
        bucket.forEach((g, idx) => {
          latestByGroup.set(`${bucketKey}|${idx}`, g);
        });
      }

      // Project parcelas in BOTH directions BY FATURA (not by calendar
      // month). Each parcela = one fatura. Forward (i=1..remaining) shifts
      // the source's fatura key by +i; backward (j=1..current-1) shifts by
      // -j. This guarantees parc N+1 is in the NEXT fatura after parc N,
      // regardless of when in the month the source was purchased.
      // Dedup later drops synths that already have a matching real tx.
      const pushSynth = (
        g: Group,
        sourceFk: string,
        fkOffset: number,
        projNum: number,
      ) => {
        if (projNum < 1 || projNum > g.total) return;
        const fk = shiftFaturaKey(sourceFk, fkOffset);
        if (!fk) return;
        // Representative date = close date of the target fatura. Falls
        // within that fatura by construction.
        const fkMatch = /^(\d{4})-(\d{2})$/.exec(fk);
        if (!fkMatch) return;
        const fkYear = Number(fkMatch[1]);
        const fkMonthIdx = Number(fkMatch[2]) - 1;
        const closeDate = getCloseDateFor(
          fkYear,
          fkMonthIdx,
          closingDay,
          overrides,
        );
        byKey.set(fk, (byKey.get(fk) || 0) + g.amount);
        if (!occurrencesByKey.has(fk)) occurrencesByKey.set(fk, []);
        // Allow optional leading zeros on BOTH sides (e.g., "01/04" with
        // total=4 needs to match the "04" too).
        const re = new RegExp(`\\b0*${g.current}\\s*/\\s*0*${g.total}\\b`);
        const padWidth = Math.max(2, String(g.total).length);
        const totalStr = String(g.total).padStart(padWidth, '0');
        const projStr = String(projNum).padStart(padWidth, '0');
        const newName = g.notes.replace(re, `${projStr}/${totalStr}`);
        synthCounter += 1;
        occurrencesByKey.get(fk)!.push({
          id: `synth-parc-${synthCounter}`,
          account: accountId,
          date: ymd(closeDate),
          amount: g.amount,
          notes: newName,
          payee: g.payeeId ?? null,
          category: g.categoryId,
          cleared: false,
          reconciled: false,
          is_parent: false,
          is_child: false,
        });
        if (!state.maxKey || fk > state.maxKey) state.maxKey = fk;
      };

      // Diagnostic: dump latestByGroup so the user can see exactly which
      // sources are driving the projection (especially when they suspect
      // duplication — e.g., "ATACADAO" appearing twice with same amount).
      // eslint-disable-next-line no-console
      console.log(
        '[parc-sources]',
        Array.from(latestByGroup.entries()).map(([k, g]) => ({
          key: k,
          notes: g.notes,
          date: g.date,
          amount: g.amount,
          current: g.current,
          total: g.total,
        })),
      );
      for (const g of latestByGroup.values()) {
        const txDate = parseYmd(g.date);
        if (!txDate) continue;
        const sourceFk = faturaForDate(txDate, closingDay, overrides);
        if (!sourceFk) continue;
        // Backward: parcelas 1 .. current-1 (will be deduped against any
        // real tx that already materialized in those past faturas)
        for (let j = 1; j < g.current; j++) {
          pushSynth(g, sourceFk, -j, g.current - j);
        }
        // Forward: parcelas current+1 .. total
        const remaining = g.total - g.current;
        for (let i = 1; i <= remaining; i++) {
          pushSynth(g, sourceFk, i, g.current + i);
        }
      }

      // === Pass 2: recurring via unbounded schedules ===
      const { data: schedules } = await aqlQuery(
        q('schedules')
          .filter({ tombstone: false, completed: false })
          .select('*'),
      );
      if (cancelled) return;
      const mySchedules = (schedules || []).filter(
        (s: { _account?: string }) => s._account === accountId,
      );

      // Names + dominant categories for recurring schedules.
      const recPayeeIds = Array.from(
        new Set(
          (
            mySchedules as Array<{
              _payee?: string;
              _date?: { endMode?: string };
            }>
          )
            .filter(s => {
              const em = s._date?.endMode;
              return em !== 'after_n_occurrences' && em !== 'on_date';
            })
            .map(s => s._payee)
            .filter((p: string | undefined): p is string => !!p),
        ),
      );
      const payeeNameById = new Map<string, string>();
      const categoryIdByPayee = new Map<string, string>();
      if (recPayeeIds.length > 0) {
        const { data: payees } = await aqlQuery(
          q('payees')
            .filter({ id: { $oneof: recPayeeIds } })
            .select(['id', 'name']),
        );
        for (const p of (payees || []) as Array<{ id: string; name: string }>) {
          payeeNameById.set(p.id, p.name);
        }
        const { data: pastTx } = await aqlQuery(
          q('transactions')
            .filter({
              account: accountId,
              payee: { $oneof: recPayeeIds },
              category: { $ne: null },
              is_parent: false,
              transfer_id: null,
            })
            .select(['payee', 'category']),
        );
        const counts = new Map<string, Map<string, number>>();
        for (const t of (pastTx || []) as Array<{
          payee: string;
          category: string;
        }>) {
          if (!t.payee || !t.category) continue;
          if (!counts.has(t.payee)) counts.set(t.payee, new Map());
          const inner = counts.get(t.payee)!;
          inner.set(t.category, (inner.get(t.category) || 0) + 1);
        }
        for (const [payee, m] of counts) {
          let max = 0;
          let top = '';
          for (const [catId, n] of m) {
            if (n > max) {
              max = n;
              top = catId;
            }
          }
          if (top) categoryIdByPayee.set(payee, top);
        }
      }

      // Fallback: category from transactions explicitly linked to this
      // schedule. Used when payee-based inference yields nothing (e.g. brand
      // new payee, or the only past txn is the one just linked).
      const categoryByScheduleId = new Map<string, string>();
      const recScheduleIds = (
        mySchedules as Array<{
          id: string;
          _date?: { endMode?: string };
        }>
      )
        .filter(s => {
          const em = s._date?.endMode;
          return em !== 'after_n_occurrences' && em !== 'on_date';
        })
        .map(s => s.id);
      if (recScheduleIds.length > 0) {
        const { data: linkedTx } = await aqlQuery(
          q('transactions')
            .filter({
              schedule: { $oneof: recScheduleIds },
              category: { $ne: null },
              is_parent: false,
              transfer_id: null,
            })
            .select(['schedule', 'category']),
        );
        for (const t of (linkedTx || []) as Array<{
          schedule: string;
          category: string;
        }>) {
          if (!t.schedule || !t.category) continue;
          if (!categoryByScheduleId.has(t.schedule)) {
            categoryByScheduleId.set(t.schedule, t.category);
          }
        }
      }

      for (const s of mySchedules) {
        const dateConfig = (s as { _date?: unknown })._date as
          | { endMode?: string }
          | undefined;
        const amount = (s as { _amount?: number })._amount;
        if (!dateConfig || amount == null) continue;
        const isUnbounded =
          dateConfig.endMode !== 'after_n_occurrences' &&
          dateConfig.endMode !== 'on_date';
        if (!isUnbounded) continue;
        const scheduleId = (s as { id: string }).id;
        const payeeId = (s as { _payee?: string })._payee;
        const rawName = (s as { name?: string }).name || '';
        const recMatch = rawName.match(/\s*\[recorrente[^\]]*\]\s*$/);
        const cleanName = recMatch
          ? rawName.slice(0, recMatch.index).trim()
          : rawName;
        const displayName =
          cleanName || (payeeId && payeeNameById.get(payeeId)) || '(sem nome)';
        try {
          const dates = (await send('schedule/get-upcoming-dates', {
            config: dateConfig,
            count: 36,
          })) as string[];
          if (cancelled) return;
          // Cap recurring projection to ~12 future faturas so we don't render
          // 36 future tabs when there are no parcelas to anchor the horizon.
          let recHorizon: string | null = null;
          {
            const today = new Date();
            const h = new Date(today.getFullYear(), today.getMonth() + 12, 1);
            recHorizon = keyFor(h.getFullYear(), h.getMonth());
          }
          for (const d of dates) {
            const dt = parseYmd(d);
            if (!dt) continue;
            const fk = faturaForDate(dt, closingDay, overrides);
            if (!fk) continue;
            // If parcelas already extended the horizon, respect that cap.
            // Otherwise cap recurring projections at recHorizon.
            const cap = state.maxKey || recHorizon;
            if (cap && fk > cap) continue;
            // Recurring entries extend the future-tab horizon too.
            if (!state.maxKey || fk > state.maxKey) state.maxKey = fk;
            byKey.set(fk, (byKey.get(fk) || 0) + amount);
            if (!occurrencesByKey.has(fk)) occurrencesByKey.set(fk, []);
            synthCounter += 1;
            occurrencesByKey.get(fk)!.push({
              id: `synth-rec-${synthCounter}`,
              account: accountId,
              date: d,
              amount,
              notes: displayName,
              payee: payeeId ?? null,
              category:
                categoryByScheduleId.get(scheduleId) ??
                (payeeId ? categoryIdByPayee.get(payeeId) : undefined),
              schedule: scheduleId,
              cleared: false,
              reconciled: false,
              is_parent: false,
              is_child: false,
            });
          }
        } catch {
          // skip
        }
      }

      // === Dedup: drop synths that already have a matching real tx ===
      // Indexes keyed by CANONICAL NOTES (payee is unreliable, often null
      // from Pluggy). Both keep an array of amounts so we can check
      // membership with the ±100¢ tolerance applied in grouping:
      //   1. realByFk[`canonical|fk`] = amount[] — covers reals with no
      //      parcela notation positioned in the same fatura.
      //   2. realByParc[`canonical|parc=N/T`] = amount[] — covers reals
      //      whose notes parse, matching the synth's projected parc number.
      const realByFk = new Map<string, number[]>();
      const realByParc = new Map<string, number[]>();
      for (const t of (allTx || []) as Array<{
        date: string;
        amount: number;
        notes: string | null;
        payee: string | null;
      }>) {
        const canonical = notesCanonical(t.notes);
        if (!canonical) continue;
        const dt = parseYmd(t.date);
        if (dt) {
          const fk = faturaForDate(dt, closingDay, overrides);
          if (fk) {
            const k = `${canonical}|fk=${fk}`;
            if (!realByFk.has(k)) realByFk.set(k, []);
            realByFk.get(k)!.push(t.amount);
          }
        }
        const parc = parseParcelInfo(t.notes);
        if (parc) {
          const k = `${canonical}|parc=${parc.current}/${parc.total}`;
          if (!realByParc.has(k)) realByParc.set(k, []);
          realByParc.get(k)!.push(t.amount);
        }
      }
      const closeEnough = (amounts: number[] | undefined, target: number) =>
        !!amounts &&
        amounts.some(a => Math.abs(a - target) <= AMOUNT_TOLERANCE);
      for (const [fk, list] of occurrencesByKey) {
        const seenSynth: Array<{ key: string; amount: number }> = [];
        const filtered: TransactionEntity[] = [];
        for (const synth of list) {
          const synthCanonical = notesCanonical(synth.notes);
          const synthParc = parseParcelInfo(synth.notes);
          // Parcelada synth: dedup ONLY against same canonical/parc=N/T.
          // Using canonical+fk would over-match the sibling parcela (e.g.,
          // parc 01 of the same purchase matches parc 02's amount and drops
          // it wrongly).
          // Non-parcelada synth (recurring): no parc info, fall back to
          // canonical+fk match.
          if (synthParc) {
            const keyParc = `${synthCanonical}|parc=${synthParc.current}/${synthParc.total}`;
            if (closeEnough(realByParc.get(keyParc), synth.amount)) {
              // eslint-disable-next-line no-console
              console.log(`[synth-dropped:parc] fk=${fk}`, {
                notes: synth.notes,
                amount: synth.amount,
                canonical: synthCanonical,
                parc: `${synthParc.current}/${synthParc.total}`,
                matchedAgainstAmounts: realByParc.get(keyParc),
              });
              continue;
            }
          } else {
            const keyFk = `${synthCanonical}|fk=${fk}`;
            if (closeEnough(realByFk.get(keyFk), synth.amount)) {
              // eslint-disable-next-line no-console
              console.log(`[synth-dropped:fk] fk=${fk}`, {
                notes: synth.notes,
                amount: synth.amount,
                canonical: synthCanonical,
                matchedAgainstAmounts: realByFk.get(keyFk),
              });
              continue;
            }
          }
          // Step 2: drop if an EARLIER synth in this same fatura already
          // covers the same canonical/parc within tolerance.
          const synthKey = synthParc
            ? `${synthCanonical}|parc=${synthParc.current}/${synthParc.total}`
            : `${synthCanonical}|notes=${synth.notes ?? ''}`;
          if (
            seenSynth.some(
              s =>
                s.key === synthKey &&
                Math.abs(s.amount - synth.amount) <= AMOUNT_TOLERANCE,
            )
          ) {
            // eslint-disable-next-line no-console
            console.log(`[synth-dropped:dup-synth] fk=${fk}`, {
              notes: synth.notes,
              amount: synth.amount,
              key: synthKey,
            });
            continue;
          }
          seenSynth.push({ key: synthKey, amount: synth.amount });
          filtered.push(synth);
        }
        if (filtered.length !== list.length) {
          occurrencesByKey.set(fk, filtered);
          const total = filtered.reduce((s, x) => s + x.amount, 0);
          if (total === 0) byKey.delete(fk);
          else byKey.set(fk, total);
        }
      }

      if (cancelled) return;
      setFutureProjection({ byKey, occurrencesByKey, maxKey: state.maxKey });
    })();
    return () => {
      cancelled = true;
    };
  }, [accountId, closingDay, overrides, txTick]);

  const { current, past, future } = useMemo(
    () =>
      computeInvoices(
        closingDay,
        overrides,
        oldestTxDate,
        futureProjection.maxKey,
      ),
    [closingDay, overrides, oldestTxDate, futureProjection.maxKey],
  );

  // On mount, default to showing the current open fatura.
  const initialized = useRef(false);
  useEffect(() => {
    if (initialized.current) return;
    initialized.current = true;
    setActiveKey(current.key);
    onSelectRange(current.from, current.to);
  }, [current.from, current.to, current.key, onSelectRange]);

  // Tab bar overflow: keep "Atual" visible by scrolling past tabs off the left.
  const tabsScrollRef = useRef<HTMLDivElement>(null);
  const currentTabRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const container = tabsScrollRef.current;
    const target = currentTabRef.current;
    if (!container || !target) return;
    if (container.scrollWidth <= container.clientWidth) {
      container.scrollLeft = 0;
      return;
    }
    container.scrollLeft = Math.max(
      0,
      target.offsetLeft - container.clientWidth + target.offsetWidth,
    );
  }, [past.length, future.length, current.key]);

  const onAll = useCallback(() => {
    setActiveKey('all');
    onSelectRange(null, null);
  }, [onSelectRange]);

  const onPick = useCallback(
    (invoice: InvoicePeriod) => {
      setActiveKey(invoice.key);
      onSelectRange(invoice.from, invoice.to);
    },
    [onSelectRange],
  );

  const activeInvoice = useMemo(() => {
    if (activeKey === 'all') return null;
    if (activeKey === current.key) return current;
    return (
      past.find(p => p.key === activeKey) ??
      future.find(f => f.key === activeKey) ??
      null
    );
  }, [activeKey, current, past, future]);

  const isFutureKey = useCallback(
    (key: string) => future.some(f => f.key === key),
    [future],
  );

  useEffect(() => {
    if (!activeInvoice) {
      setActiveTotal(null);
      onActiveTotalChange?.(null);
      return;
    }
    // For future invoices show the PROJECTED total (sum of schedules);
    // for past/current, sum real transactions in the period.
    if (isFutureKey(activeInvoice.key)) {
      const total = futureProjection.byKey.get(activeInvoice.key) ?? 0;
      setActiveTotal(total);
      onActiveTotalChange?.(total);
      return;
    }
    let cancelled = false;
    void (async () => {
      // Sum only EXPENSES (negative amounts) so the big balance matches the
      // sum shown in the Resumo (à vista + parcelados). Payments/credits to
      // the card are excluded. We fetch rows (not $sum) so we can apply a
      // defensive in-memory date filter — guards against any leakage in the
      // AQL date filter.
      const { data } = await aqlQuery(
        q('transactions')
          .filter({
            account: accountId,
            date: { $gte: activeInvoice.from, $lte: activeInvoice.to },
            is_parent: false,
            transfer_id: null,
            amount: { $lt: 0 },
          })
          .select(['date', 'amount']),
      );
      if (cancelled) return;
      let n = 0;
      for (const t of (data || []) as Array<{
        date?: string;
        amount: number;
      }>) {
        if (
          t.date &&
          (t.date < activeInvoice.from || t.date > activeInvoice.to)
        ) {
          continue;
        }
        n += t.amount;
      }
      setActiveTotal(n);
      onActiveTotalChange?.(n);
    })();
    return () => {
      cancelled = true;
    };
  }, [
    accountId,
    activeInvoice,
    isFutureKey,
    futureProjection.byKey,
    onActiveTotalChange,
  ]);

  // Emit synthetic transactions to Account so it can hand them to
  // TransactionsTable when the active tab is a future invoice. Otherwise
  // emit null so real transactions render.
  useEffect(() => {
    if (!activeInvoice || !isFutureKey(activeInvoice.key)) {
      onFutureTransactionsChange?.(null);
      return;
    }
    const txs = futureProjection.occurrencesByKey.get(activeInvoice.key) || [];
    // Parcelas first (grouped), then recurring. Within each group, ascending
    // by date.
    const sorted = [...txs].sort((a, b) => {
      const aParc = typeof a.id === 'string' && a.id.startsWith('synth-parc');
      const bParc = typeof b.id === 'string' && b.id.startsWith('synth-parc');
      if (aParc && !bParc) return -1;
      if (!aParc && bParc) return 1;
      return (a.date ?? '').localeCompare(b.date ?? '');
    });
    onFutureTransactionsChange?.(sorted);
  }, [
    activeInvoice,
    isFutureKey,
    futureProjection.occurrencesByKey,
    onFutureTransactionsChange,
  ]);

  // Compute breakdown (à vista vs parcelada) from REAL transactions for past
  // and current faturas, or from SYNTHETIC projections for future faturas.
  useEffect(() => {
    if (!activeInvoice) {
      setSummary(null);
      return;
    }
    if (isFutureKey(activeInvoice.key)) {
      const synths =
        futureProjection.occurrencesByKey.get(activeInvoice.key) || [];
      let avistaTotal = 0;
      let avistaCount = 0;
      let parcTotal = 0;
      let parcCount = 0;
      for (const t of synths) {
        if (t.amount == null || t.amount >= 0) continue;
        const isParc =
          (typeof t.id === 'string' && t.id.startsWith('synth-parc')) ||
          isParceladaText(t.notes);
        if (isParc) {
          parcTotal += t.amount;
          parcCount += 1;
        } else {
          avistaTotal += t.amount;
          avistaCount += 1;
        }
      }
      setSummary({
        avista: { total: avistaTotal, count: avistaCount },
        parcelada: { total: parcTotal, count: parcCount },
      });
      return;
    }
    let cancelled = false;
    void (async () => {
      const { data } = await aqlQuery(
        q('transactions')
          .filter({
            account: accountId,
            date: { $gte: activeInvoice.from, $lte: activeInvoice.to },
            is_parent: false,
            transfer_id: null,
          })
          .select(['date', 'amount', 'notes', 'schedule']),
      );
      if (cancelled) return;
      let avistaTotal = 0;
      let avistaCount = 0;
      let parcTotal = 0;
      let parcCount = 0;
      let outOfRange = 0;
      const dateHistogram: Record<string, number> = {};
      for (const t of (data || []) as Array<{
        date?: string;
        amount: number;
        notes: string | null;
        schedule: string | null;
      }>) {
        if (t.amount >= 0) continue;
        // Belt-and-suspenders: even if the AQL date filter misbehaves,
        // discard any row whose date falls outside the active invoice range.
        if (
          t.date &&
          (t.date < activeInvoice.from || t.date > activeInvoice.to)
        ) {
          outOfRange += 1;
          if (t.date) {
            const month = t.date.slice(0, 7);
            dateHistogram[month] = (dateHistogram[month] || 0) + 1;
          }
          continue;
        }
        const isParc = isParceladaText(t.notes);
        if (isParc) {
          parcTotal += t.amount;
          parcCount += 1;
        } else {
          avistaTotal += t.amount;
          avistaCount += 1;
        }
      }
      // eslint-disable-next-line no-console
      console.log(
        `[summary] ${activeInvoice.label} (${activeInvoice.from}→${activeInvoice.to}): ${data?.length || 0} rows queried | avista=${avistaCount}/${avistaTotal} | parc=${parcCount}/${parcTotal} | DROPPED outOfRange=${outOfRange}`,
        outOfRange > 0
          ? { dateHistogramOfDroppedRows: dateHistogram }
          : undefined,
      );
      setSummary({
        avista: { total: avistaTotal, count: avistaCount },
        parcelada: { total: parcTotal, count: parcCount },
      });
    })();
    return () => {
      cancelled = true;
    };
  }, [
    accountId,
    activeInvoice,
    isFutureKey,
    futureProjection.occurrencesByKey,
  ]);

  const onDayPicked = useCallback(
    (newDayStr: string) => {
      if (!activeInvoice) {
        // Editing default closing day
        if (newDayStr === '') return;
        const n = parseInt(newDayStr, 10);
        if (!Number.isFinite(n) || n < 1 || n > 31) return;
        setClosingDayValue(String(n));
        return;
      }
      // Empty value clears the override for this fatura
      if (newDayStr === '') {
        const next = { ...overrides };
        delete next[activeInvoice.key];
        setClosingsValue(JSON.stringify(next));
        return;
      }
      const n = parseInt(newDayStr, 10);
      if (!Number.isFinite(n) || n < 1 || n > 31) return;
      const [yStr, mStr] = activeInvoice.key.split('-');
      const labelYear = Number(yStr);
      const labelMonthIdx = Number(mStr) - 1;
      const closeYear = labelMonthIdx === 0 ? labelYear - 1 : labelYear;
      const closeMonthIdx = labelMonthIdx === 0 ? 11 : labelMonthIdx - 1;
      const d = clampDay(closeYear, closeMonthIdx, n);
      const next = { ...overrides, [activeInvoice.key]: ymd(d) };
      setClosingsValue(JSON.stringify(next));
    },
    [activeInvoice, overrides, setClosingDayValue, setClosingsValue],
  );

  const dayOptions = useMemo<Array<[string, string]>>(() => {
    const closeMonthIdx = activeInvoice
      ? (parseYmd(activeInvoice.to)?.getMonth() ?? null)
      : null;
    const suffix =
      closeMonthIdx != null ? ` de ${MONTH_SHORT[closeMonthIdx]}` : '';
    const opts: Array<[string, string]> = [];
    if (activeInvoice) {
      opts.push(['', t('— padrão ({{def}}) —', { def: closingDay })]);
    }
    for (let i = 1; i <= 31; i++) {
      opts.push([String(i), `${i}${suffix}`]);
    }
    return opts;
  }, [activeInvoice, closingDay, t]);

  const selectedDayValue = activeInvoice
    ? activeInvoice.overridden
      ? String(parseYmd(activeInvoice.to)?.getDate() ?? closingDay)
      : ''
    : String(closingDay);

  const Tab = ({
    label,
    active,
    onClick,
    title,
    tabRef,
  }: {
    label: string;
    active: boolean;
    onClick: () => void;
    title?: string;
    tabRef?: Ref<HTMLButtonElement>;
  }) => (
    <Button
      ref={tabRef}
      variant={active ? 'primary' : 'bare'}
      onPress={onClick}
      style={{
        fontSize: 13,
        fontWeight: active ? 600 : 500,
        padding: '6px 14px',
        borderRadius: 999,
        whiteSpace: 'nowrap',
        flexShrink: 0,
        border: active ? undefined : `1px solid ${theme.tableBorder}`,
      }}
      aria-label={title}
    >
      {label}
    </Button>
  );

  return (
    <>
      <View
        style={{
          flexDirection: 'row',
          alignItems: 'center',
          gap: 10,
          padding: '12px 20px',
          borderBottom: `1px solid ${theme.tableBorder}`,
          backgroundColor: theme.tableBackground,
          flexShrink: 0,
        }}
      >
        <Tab
          label={t('Histórico geral')}
          active={activeKey === 'all'}
          onClick={onAll}
        />
        <View
          style={{
            width: 1,
            height: 18,
            backgroundColor: theme.tableBorder,
            flexShrink: 0,
          }}
        />
        <View
          innerRef={tabsScrollRef}
          style={{
            flex: 1,
            minWidth: 0,
            flexDirection: 'row',
            alignItems: 'center',
            gap: 8,
            overflowX: 'auto',
          }}
        >
          {[...past].reverse().map(inv => (
            <Tab
              key={inv.key}
              label={inv.label}
              active={activeKey === inv.key}
              onClick={() => onPick(inv)}
              title={`${inv.from} → ${inv.to}`}
            />
          ))}
          <Tab
            tabRef={currentTabRef}
            label={t('Atual ({{label}})', { label: current.label })}
            active={activeKey === current.key}
            onClick={() => onPick(current)}
            title={`${current.from} → ${current.to}`}
          />
          {future.length > 0 && (
            <View
              style={{
                width: 1,
                height: 18,
                backgroundColor: theme.tableBorder,
                margin: '0 4px',
                flexShrink: 0,
              }}
            />
          )}
          {future.map(inv => (
            <Button
              key={inv.key}
              variant={activeKey === inv.key ? 'primary' : 'bare'}
              onPress={() => onPick(inv)}
              style={{
                fontSize: 13,
                fontWeight: activeKey === inv.key ? 600 : 500,
                padding: '6px 14px',
                borderRadius: 999,
                whiteSpace: 'nowrap',
                fontStyle: 'italic',
                opacity: activeKey === inv.key ? 1 : 0.75,
                flexShrink: 0,
                border:
                  activeKey === inv.key
                    ? undefined
                    : `1px dashed ${theme.tableBorder}`,
              }}
              aria-label={`${inv.from} → ${inv.to} (previsto)`}
            >
              {inv.label}
            </Button>
          ))}
        </View>
        <View
          style={{
            flexDirection: 'row',
            alignItems: 'center',
            gap: 8,
            flexShrink: 0,
            marginLeft: 12,
            padding: '4px 10px 4px 14px',
            borderRadius: 999,
            backgroundColor: theme.pillBackground,
          }}
        >
          <Text
            style={{
              fontSize: 12,
              color: theme.pageTextSubdued,
            }}
          >
            {activeInvoice ? t('fecha dia') : t('fechamento padrão')}
          </Text>
          <Select
            aria-label={t('Dia de fechamento')}
            value={selectedDayValue}
            onChange={onDayPicked}
            options={dayOptions}
            style={{
              minWidth: 70,
              fontSize: 12,
              fontWeight: 600,
              border: 'none',
              backgroundColor: 'transparent',
            }}
          />
        </View>
      </View>

      {summary && (
        <View
          style={{
            flexDirection: 'row',
            alignItems: 'stretch',
            gap: 12,
            padding: '16px 20px',
            borderBottom: `1px solid ${theme.tableBorder}`,
            backgroundColor: theme.tableBackground,
            flexShrink: 0,
          }}
        >
          {[
            {
              label: t('À vista'),
              total: summary.avista.total,
              count: summary.avista.count,
            },
            {
              label: t('Parcelados'),
              total: summary.parcelada.total,
              count: summary.parcelada.count,
            },
            {
              label: t('Total da fatura'),
              total: summary.avista.total + summary.parcelada.total,
              count: summary.avista.count + summary.parcelada.count,
              emphasis: true as const,
            },
          ].map(card => (
            <View
              key={card.label}
              style={{
                flex: 1,
                padding: '14px 18px',
                borderRadius: 14,
                backgroundColor: card.emphasis
                  ? theme.pageBackground
                  : theme.pillBackground,
                border: card.emphasis
                  ? `1px solid ${theme.tableBorder}`
                  : undefined,
                gap: 6,
              }}
            >
              <View
                style={{
                  flexDirection: 'row',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                }}
              >
                <Text
                  style={{
                    fontSize: 12,
                    fontWeight: 600,
                    letterSpacing: 0.3,
                    textTransform: 'uppercase',
                    color: theme.pageTextSubdued,
                  }}
                >
                  {card.label}
                </Text>
                <Text
                  style={{
                    fontSize: 11,
                    color: theme.pageTextSubdued,
                    padding: '2px 8px',
                    borderRadius: 999,
                    backgroundColor: theme.tableBackground,
                  }}
                >
                  {card.count}
                </Text>
              </View>
              <Text
                style={{
                  fontSize: card.emphasis ? 26 : 20,
                  fontWeight: 700,
                  letterSpacing: -0.3,
                  fontFeatureSettings: '"tnum", "ss01"',
                  color: card.total < 0 ? theme.errorText : theme.pageText,
                }}
              >
                {(card.total / 100).toLocaleString('pt-BR', {
                  style: 'currency',
                  currency: 'BRL',
                })}
              </Text>
            </View>
          ))}
        </View>
      )}
    </>
  );
}
