import { useEffect, useMemo, useState } from 'react';

import { q } from '@actual-app/core/shared/query';

import { useSyncedPref } from '#hooks/useSyncedPref';
import { aqlQuery } from '#queries/aqlQuery';

const DEFAULT_CLOSING_DAY = 24;

type ClosingsMap = Record<string, string>;

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

function clampDay(year: number, monthIdx: number, day: number): Date {
  const lastDay = new Date(year, monthIdx + 1, 0).getDate();
  return new Date(year, monthIdx, Math.min(day, lastDay));
}

function parseClosings(raw: string | undefined): ClosingsMap {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    return typeof parsed === 'object' && parsed !== null ? parsed : {};
  } catch {
    return {};
  }
}

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

// Returns the [from, to] window of the fatura currently open, using the
// same conventions as InvoiceTabs (close > today = future close, else past).
function currentInvoiceRange(
  closingDay: number,
  overrides: ClosingsMap,
  today: Date,
): { from: Date; to: Date; labelKey: string } {
  let y = today.getFullYear();
  let m = today.getMonth();
  for (let i = 0; i < 24; i++) {
    const close = getCloseDateFor(y, m, closingDay, overrides);
    if (close > today) {
      const prevY = m === 0 ? y - 1 : y;
      const prevM = m === 0 ? 11 : m - 1;
      const prevClose = getCloseDateFor(prevY, prevM, closingDay, overrides);
      const from = new Date(prevClose);
      from.setDate(from.getDate() + 1);
      return { from, to: close, labelKey: keyFor(y, m) };
    }
    m += 1;
    if (m > 11) {
      m = 0;
      y += 1;
    }
  }
  return { from: today, to: today, labelKey: keyFor(y, m) };
}

// Sum of (cents) transactions for `accountId` inside the current open invoice.
// Returns null while loading or if the account has no configured closing day
// AND no explicit closings override (i.e., not a credit-card-style account).
export function useCurrentInvoiceTotal(accountId: string | undefined): {
  total: number | null;
  fromDate: string | null;
  toDate: string | null;
} {
  const [closingDayValue] = useSyncedPref(`closing-day-${accountId ?? ''}`);
  const [closingsValue] = useSyncedPref(`invoice-closings-${accountId ?? ''}`);

  const isConfigured = closingDayValue !== undefined || !!closingsValue;

  const closingDay = Number(closingDayValue) || DEFAULT_CLOSING_DAY;
  const overrides = useMemo(
    () => parseClosings(closingsValue),
    [closingsValue],
  );

  const range = useMemo(() => {
    if (!isConfigured || !accountId) return null;
    return currentInvoiceRange(closingDay, overrides, new Date());
  }, [closingDay, overrides, isConfigured, accountId]);

  const [total, setTotal] = useState<number | null>(null);

  const fromStr = useMemo(() => (range ? ymd(range.from) : ''), [range]);
  const toStr = useMemo(() => (range ? ymd(range.to) : ''), [range]);

  useEffect(() => {
    let cancelled = false;
    if (!accountId || !fromStr || !toStr) {
      setTotal(null);
      return;
    }
    void (async () => {
      try {
        // Match InvoiceTabs' summary semantics: only real spending
        // (amount < 0, not split parents, not transfers) inside the active
        // invoice's date range. À vista + parcelada totals add up to this.
        const { data } = await aqlQuery(
          q('transactions')
            .filter({
              account: accountId,
              date: { $gte: fromStr, $lte: toStr },
              is_parent: false,
              transfer_id: null,
            })
            .select(['amount', 'date']),
        );
        if (cancelled) return;
        let sum = 0;
        for (const t of (data || []) as Array<{
          amount: number;
          date?: string;
        }>) {
          if (t.amount >= 0) continue;
          if (t.date && (t.date < fromStr || t.date > toStr)) continue;
          sum += t.amount;
        }
        setTotal(sum);
      } catch {
        if (!cancelled) setTotal(null);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [accountId, fromStr, toStr]);

  return {
    total: range ? total : null,
    fromDate: range ? ymd(range.from) : null,
    toDate: range ? ymd(range.to) : null,
  };
}
