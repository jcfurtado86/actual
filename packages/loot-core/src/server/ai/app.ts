// @ts-strict-ignore
import * as asyncStorage from '#platform/server/asyncStorage';
import * as connection from '#platform/server/connection';
import { logger } from '#platform/server/log';
import { createApp } from '#server/app';
import { aqlQuery } from '#server/aql';
import * as db from '#server/db';
import { post } from '#server/post';
import * as prefs from '#server/prefs';
import { createSchedule, deleteSchedule } from '#server/schedules/app';
import { getServer } from '#server/server-config';
import { batchUpdateTransactions } from '#server/transactions';
import { q } from '#shared/query';

async function getAutoCategorizePref(): Promise<boolean> {
  try {
    const row = await db.first<{ value: string }>(
      "SELECT value FROM preferences WHERE id = 'aiAutoCategorize'",
    );
    // Default to enabled when unset
    return row?.value !== 'false';
  } catch {
    return true;
  }
}

export type AIHandlers = {
  'ai-insights': typeof getInsights;
  'ai-insights-list': typeof listInsights;
  'ai-insights-delete': typeof deleteInsight;
  'ai-chat-send': typeof sendChatMessage;
  'ai-chat-list': typeof listChatMessages;
  'ai-chat-clear': typeof clearChat;
  'ai-categorize-transactions': typeof categorizeTransactions;
  'ai-auto-categorize-after-sync': typeof autoCategorizeAfterSync;
  'ai-categorize-pending': typeof categorizePending;
  'ai-cleanup-actual-ai-tags': typeof cleanupActualAiTags;
  'ai-log-list': typeof listAiLog;
  'ai-detect-and-create-schedules': typeof detectAndCreateSchedules;
  'ai-delete-all-schedules': typeof deleteAllSchedules;
};

type ChatMessage = {
  role: 'user' | 'assistant';
  content: string;
  timestamp: string;
  model?: string;
  tokens?: { input: number; output: number };
};

type ChatPayload = {
  messages: ChatMessage[];
  latest?: ChatMessage;
};

type InsightRecord = {
  id: string;
  generatedAt: string;
  lookbackDays: number;
  model: string;
  analyzed: number;
  tokens: { input: number; output: number } | null;
  html: string;
};

type InsightsResult = InsightRecord | { error: string };

async function getInsights({
  lookbackDays = 7,
}: { lookbackDays?: number } = {}): Promise<InsightsResult> {
  const today = new Date();
  const since = new Date(today.getTime() - lookbackDays * 86400000);
  const sinceStr = since.toISOString().slice(0, 10);

  const { data } = await aqlQuery(
    q('transactions')
      .filter({
        date: { $gte: sinceStr },
        'account.offbudget': false,
        is_parent: false,
        transfer_id: null,
      })
      .select([
        'date',
        'amount',
        'notes',
        { payee_name: 'payee.name' },
        { category_name: 'category.name' },
        { category_group: 'category.group.name' },
        { account_name: 'account.name' },
      ])
      .orderBy({ date: 'desc' }),
  );

  if (!data || data.length === 0) {
    return { error: 'no-transactions' };
  }

  const userToken = await asyncStorage.getItem('user-token');
  if (!userToken) {
    return { error: 'not-logged-in' };
  }

  const serverConfig = getServer();
  if (!serverConfig) {
    return { error: 'no-server-configured' };
  }

  const fileId = prefs.getPrefs()?.cloudFileId;

  try {
    // post() throws PostError on non-2xx; on 200 OK it returns response.data
    // already unwrapped from { status: 'ok', data: ... }.
    const result = await post(
      serverConfig.BASE_SERVER + '/ai/insights',
      {
        fileId,
        lookbackDays,
        currency: 'R$',
        transactions: data,
      },
      { 'X-ACTUAL-TOKEN': userToken },
    );
    return result;
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
}

async function listInsights(): Promise<InsightRecord[] | { error: string }> {
  const userToken = await asyncStorage.getItem('user-token');
  if (!userToken) return { error: 'not-logged-in' };

  const serverConfig = getServer();
  if (!serverConfig) return { error: 'no-server-configured' };

  const fileId = prefs.getPrefs()?.cloudFileId;
  if (!fileId) return { error: 'no-budget-loaded' };

  try {
    const result = await post(
      serverConfig.BASE_SERVER + '/ai/insights/list',
      { fileId },
      { 'X-ACTUAL-TOKEN': userToken },
    );
    return result;
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
}

async function deleteInsight({
  id,
}: {
  id: string;
}): Promise<InsightRecord[] | { error: string }> {
  const userToken = await asyncStorage.getItem('user-token');
  if (!userToken) return { error: 'not-logged-in' };

  const serverConfig = getServer();
  if (!serverConfig) return { error: 'no-server-configured' };

  const fileId = prefs.getPrefs()?.cloudFileId;
  if (!fileId) return { error: 'no-budget-loaded' };

  try {
    const result = await post(
      serverConfig.BASE_SERVER + '/ai/insights/delete',
      { fileId, id },
      { 'X-ACTUAL-TOKEN': userToken },
    );
    return result;
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
}

const CHAT_CONTEXT_LOOKBACK_DAYS = 90;

async function gatherChatContext() {
  const today = new Date();
  const since = new Date(
    today.getTime() - CHAT_CONTEXT_LOOKBACK_DAYS * 86400000,
  );
  const sinceStr = since.toISOString().slice(0, 10);

  const [txRes, accRes, catRes] = await Promise.all([
    aqlQuery(
      q('transactions')
        .filter({
          date: { $gte: sinceStr },
          is_parent: false,
          transfer_id: null,
        })
        .select([
          'date',
          'amount',
          { payee_name: 'payee.name' },
          { category_name: 'category.name' },
          { category_group: 'category.group.name' },
          { account_name: 'account.name' },
        ])
        .orderBy({ date: 'desc' }),
    ),
    aqlQuery(
      q('accounts').filter({ closed: false }).select(['name', 'offbudget']),
    ),
    aqlQuery(
      q('categories')
        .filter({ tombstone: false })
        .select(['name', { group: 'group.name' }]),
    ),
  ]);

  return {
    asOfDate: today.toISOString().slice(0, 10),
    transactions: txRes.data || [],
    accounts: accRes.data || [],
    categories: catRes.data || [],
  };
}

async function sendChatMessage({
  message,
}: {
  message: string;
}): Promise<ChatPayload | { error: string }> {
  const userToken = await asyncStorage.getItem('user-token');
  if (!userToken) return { error: 'not-logged-in' };

  const serverConfig = getServer();
  if (!serverConfig) return { error: 'no-server-configured' };

  const fileId = prefs.getPrefs()?.cloudFileId;
  if (!fileId) return { error: 'no-budget-loaded' };

  if (!message?.trim()) return { error: 'empty-message' };

  const contextData = await gatherChatContext();

  try {
    const result = await post(
      serverConfig.BASE_SERVER + '/ai/chat/send',
      { fileId, message: message.trim(), contextData },
      { 'X-ACTUAL-TOKEN': userToken },
    );
    return result;
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
}

async function listChatMessages(): Promise<ChatPayload | { error: string }> {
  const userToken = await asyncStorage.getItem('user-token');
  if (!userToken) return { error: 'not-logged-in' };

  const serverConfig = getServer();
  if (!serverConfig) return { error: 'no-server-configured' };

  const fileId = prefs.getPrefs()?.cloudFileId;
  if (!fileId) return { error: 'no-budget-loaded' };

  try {
    const result = await post(
      serverConfig.BASE_SERVER + '/ai/chat/list',
      { fileId },
      { 'X-ACTUAL-TOKEN': userToken },
    );
    return result;
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
}

async function clearChat(): Promise<ChatPayload | { error: string }> {
  const userToken = await asyncStorage.getItem('user-token');
  if (!userToken) return { error: 'not-logged-in' };

  const serverConfig = getServer();
  if (!serverConfig) return { error: 'no-server-configured' };

  const fileId = prefs.getPrefs()?.cloudFileId;
  if (!fileId) return { error: 'no-budget-loaded' };

  try {
    const result = await post(
      serverConfig.BASE_SERVER + '/ai/chat/clear',
      { fileId },
      { 'X-ACTUAL-TOKEN': userToken },
    );
    return result;
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
}

type CategorizeResult =
  | {
      updated: number;
      skipped: number;
      suggestions: Array<{
        transactionId: string;
        categoryId: string;
        confidence?: string;
      }>;
      model: string;
      tokens: { input: number; output: number } | null;
    }
  | { error: string };

const CATEGORIZE_BATCH_SIZE = 60;

async function categorizeTransactions({
  ids,
  auto = false,
}: {
  ids: string[];
  auto?: boolean;
}): Promise<CategorizeResult> {
  const userToken = await asyncStorage.getItem('user-token');
  if (!userToken) return { error: 'not-logged-in' };

  const serverConfig = getServer();
  if (!serverConfig) return { error: 'no-server-configured' };

  const fileId = prefs.getPrefs()?.cloudFileId;

  if (!Array.isArray(ids) || ids.length === 0) {
    return { error: 'no-transactions' };
  }

  // Fetch transactions to categorize. Skip parent splits and transfers.
  const { data: txData } = await aqlQuery(
    q('transactions')
      .filter({
        id: { $oneof: ids },
        is_parent: false,
        transfer_id: null,
      })
      .select([
        'id',
        'date',
        'amount',
        'notes',
        'imported_payee',
        'payee',
        { payee_name: 'payee.name' },
        { current_category_name: 'category.name' },
      ]),
  );

  if (!txData || txData.length === 0) {
    return { error: 'no-transactions' };
  }

  // Fetch categories
  const { data: catData } = await aqlQuery(
    q('categories')
      .filter({ tombstone: false, is_income: false })
      .select(['id', 'name', { group: 'group.name' }]),
  );

  if (!catData || catData.length === 0) {
    return { error: 'no-categories' };
  }

  // Pre-pass: for each tx with a known payee, see if we have prior
  // categorized transactions with the same payee. If yes, apply the most
  // frequent category for that payee directly — no AI call needed.
  const payeesNeeded = Array.from(
    new Set(
      txData
        .map((t: { payee: string | null }) => t.payee)
        .filter((p): p is string => !!p),
    ),
  );
  const validCatIds = new Set(catData.map((c: { id: string }) => c.id));

  const dominantByPayee = new Map<string, string>();
  if (payeesNeeded.length > 0) {
    const { data: historical } = await aqlQuery(
      q('transactions')
        .filter({
          payee: { $oneof: payeesNeeded },
          category: { $ne: null },
          is_parent: false,
          transfer_id: null,
          id: { $notOneof: txData.map((t: { id: string }) => t.id) },
        })
        .select(['payee', 'category']),
    );
    const counts = new Map<string, Map<string, number>>();
    for (const h of historical || []) {
      if (!h.payee || !h.category || !validCatIds.has(h.category)) continue;
      if (!counts.has(h.payee)) counts.set(h.payee, new Map());
      const map = counts.get(h.payee)!;
      map.set(h.category, (map.get(h.category) || 0) + 1);
    }
    for (const [payee, catMap] of counts) {
      let max = 0;
      let top = '';
      for (const [cat, n] of catMap) {
        if (n > max) {
          max = n;
          top = cat;
        }
      }
      if (top) dominantByPayee.set(payee, top);
    }
  }

  const fromHistoryUpdates: Array<{ id: string; category: string }> = [];
  const needsAi: typeof txData = [];
  for (const t of txData) {
    const guess = t.payee ? dominantByPayee.get(t.payee) : undefined;
    if (guess) {
      fromHistoryUpdates.push({ id: t.id, category: guess });
    } else {
      needsAi.push(t);
    }
  }

  if (fromHistoryUpdates.length > 0) {
    await batchUpdateTransactions({ updated: fromHistoryUpdates });
    connection.send('sync-event', {
      type: 'success',
      tables: ['transactions'],
    });
    logger.log(
      `[ai-categorize] applied ${fromHistoryUpdates.length} from payee history; ${needsAi.length} remaining for AI`,
    );
  }

  if (needsAi.length === 0) {
    return {
      updated: fromHistoryUpdates.length,
      skipped: 0,
      suggestions: fromHistoryUpdates.map(u => ({
        transactionId: u.id,
        categoryId: u.category,
        confidence: 'history' as string,
      })),
      model: 'payee-history',
      tokens: { input: 0, output: 0 },
    };
  }

  // Split remaining (no-history) into batches to avoid output truncation.
  const batches: Array<typeof txData> = [];
  for (let i = 0; i < needsAi.length; i += CATEGORIZE_BATCH_SIZE) {
    batches.push(needsAi.slice(i, i + CATEGORIZE_BATCH_SIZE));
  }

  const allSuggestions: Array<{
    transactionId: string;
    categoryId: string;
    confidence?: string;
  }> = [];
  const totalTokens = { input: 0, output: 0 };
  let modelName = 'unknown';

  for (const batch of batches) {
    let serverResult;
    try {
      serverResult = await post(
        serverConfig.BASE_SERVER + '/ai/categorize',
        { fileId, auto, transactions: batch, categories: catData },
        { 'X-ACTUAL-TOKEN': userToken },
      );
    } catch (err) {
      return { error: err instanceof Error ? err.message : String(err) };
    }
    const suggestions = (serverResult?.suggestions || []) as Array<{
      transactionId: string;
      categoryId: string;
      confidence?: string;
    }>;
    if (serverResult?.tokens) {
      totalTokens.input += serverResult.tokens.input;
      totalTokens.output += serverResult.tokens.output;
    }
    if (serverResult?.model) modelName = serverResult.model;

    // Apply this batch's updates immediately so the UI reflects progress
    // batch-by-batch instead of waiting for all batches to finish.
    if (suggestions.length > 0) {
      const batchUpdates = suggestions.map(s => ({
        id: s.transactionId,
        category: s.categoryId,
      }));
      await batchUpdateTransactions({ updated: batchUpdates });
      allSuggestions.push(...suggestions);

      // Tell the client to invalidate its transaction caches so the
      // visible list re-fetches without a manual reload.
      connection.send('sync-event', {
        type: 'success',
        tables: ['transactions'],
      });
    }
  }

  return {
    updated: fromHistoryUpdates.length + allSuggestions.length,
    skipped: needsAi.length - allSuggestions.length,
    suggestions: [
      ...fromHistoryUpdates.map(u => ({
        transactionId: u.id,
        categoryId: u.category,
        confidence: 'history' as string,
      })),
      ...allSuggestions,
    ],
    model: modelName,
    tokens: totalTokens,
  };
}

async function autoCategorizeAfterSync({
  ids,
}: {
  ids: string[];
}): Promise<
  { skipped: 'pref-off' } | { skipped: 'no-ids' } | CategorizeResult
> {
  if (!ids || ids.length === 0) return { skipped: 'no-ids' };
  const enabled = await getAutoCategorizePref();
  if (!enabled) return { skipped: 'pref-off' };
  return categorizeTransactions({ ids, auto: true });
}

type AiLogEntry = {
  id: string;
  timestamp: string;
  op: 'insights' | 'chat' | 'categorize' | 'auto-categorize';
  status: 'running' | 'ok' | 'error';
  model?: string;
  durationMs?: number;
  tokens?: { input: number; output: number } | null;
  summary?: string;
  error?: string;
};

const PENDING_BATCH_SIZE = 60;

async function categorizePending({
  lookbackDays,
}: {
  lookbackDays?: number;
} = {}): Promise<
  | {
      found: number;
      updated: number;
      skipped: number;
      batches: number;
      tokens: { input: number; output: number };
    }
  | { error: string }
> {
  const filter: Record<string, unknown> = {
    category: null,
    is_parent: false,
    transfer_id: null,
  };
  if (lookbackDays && lookbackDays > 0) {
    const since = new Date(Date.now() - lookbackDays * 86400000)
      .toISOString()
      .slice(0, 10);
    filter.date = { $gte: since };
  }

  const { data } = await aqlQuery(
    q('transactions').filter(filter).select(['id']).orderBy({ date: 'desc' }),
  );

  if (!data || data.length === 0) {
    return {
      found: 0,
      updated: 0,
      skipped: 0,
      batches: 0,
      tokens: { input: 0, output: 0 },
    };
  }

  const ids = data.map((t: { id: string }) => t.id);
  let totalUpdated = 0;
  let totalSkipped = 0;
  let batches = 0;
  const totalTokens = { input: 0, output: 0 };

  for (let i = 0; i < ids.length; i += PENDING_BATCH_SIZE) {
    const chunk = ids.slice(i, i + PENDING_BATCH_SIZE);
    const res = await categorizeTransactions({ ids: chunk, auto: true });
    batches++;
    if ('error' in res) {
      return { error: res.error };
    }
    totalUpdated += res.updated;
    totalSkipped += res.skipped;
    if (res.tokens) {
      totalTokens.input += res.tokens.input;
      totalTokens.output += res.tokens.output;
    }
  }

  return {
    found: ids.length,
    updated: totalUpdated,
    skipped: totalSkipped,
    batches,
    tokens: totalTokens,
  };
}

async function cleanupActualAiTags(): Promise<{
  scanned: number;
  cleaned: number;
}> {
  const { data } = await aqlQuery(
    q('transactions')
      .filter({ notes: { $like: '%#actual-ai%' } })
      .select(['id', 'notes']),
  );

  if (!data || data.length === 0) {
    return { scanned: 0, cleaned: 0 };
  }

  // Strip the longer tag first to avoid partial matches.
  const stripRegex = /#actual-ai(-miss)?/g;
  const updates: Array<{ id: string; notes: string | null }> = [];
  for (const t of data as Array<{ id: string; notes: string | null }>) {
    if (!t.notes) continue;
    const cleaned = t.notes
      .replace(stripRegex, '')
      .replace(/[ \t]{2,}/g, ' ')
      .trim();
    if (cleaned !== t.notes) {
      updates.push({ id: t.id, notes: cleaned === '' ? null : cleaned });
    }
  }

  if (updates.length > 0) {
    await batchUpdateTransactions({ updated: updates });
    connection.send('sync-event', {
      type: 'success',
      tables: ['transactions'],
    });
  }

  return { scanned: data.length, cleaned: updates.length };
}

// ====================================================================
// Schedule detection (parceladas via regex + recorrentes via IA)
// ====================================================================

type Parcelado = {
  txId: string;
  payeeId: string;
  payeeName: string;
  accountId: string;
  accountName: string;
  amount: number;
  date: string;
  current: number;
  total: number;
};

const PARC_REGEX = /(?:\bparc[.\s]*|\b)(\d{1,2})\s*[/de]+\s*(\d{1,2})/i;

function parseParcelInfo(
  text: string | null | undefined,
): { current: number; total: number } | null {
  if (!text) return null;
  const m = PARC_REGEX.exec(text);
  if (!m) return null;
  const current = parseInt(m[1], 10);
  const total = parseInt(m[2], 10);
  if (
    !Number.isFinite(current) ||
    !Number.isFinite(total) ||
    current < 1 ||
    total < 2 ||
    current > total ||
    total > 36
  ) {
    return null;
  }
  return { current, total };
}

function addMonthsClampDay(date: Date, monthsToAdd: number): Date {
  const y = date.getFullYear();
  const m = date.getMonth() + monthsToAdd;
  const d = date.getDate();
  const target = new Date(y, m, 1);
  const lastDay = new Date(
    target.getFullYear(),
    target.getMonth() + 1,
    0,
  ).getDate();
  return new Date(
    target.getFullYear(),
    target.getMonth(),
    Math.min(d, lastDay),
  );
}

function ymdLocal(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

async function detectAndCreateSchedules({
  ids,
  skipRecurring = false,
}: {
  ids?: string[];
  skipRecurring?: boolean;
} = {}): Promise<
  | {
      parceladas: { detected: number; created: number };
      recurring: { detected: number; created: number };
      error?: string;
    }
  | { error: string }
> {
  const userToken = await asyncStorage.getItem('user-token');
  if (!userToken) return { error: 'not-logged-in' };
  const serverConfig = getServer();
  if (!serverConfig) return { error: 'no-server-configured' };

  // --- 1) Parceladas via regex ----------------------------------------
  const baseFilter: Record<string, unknown> = {
    is_parent: false,
    transfer_id: null,
    schedule: null,
    payee: { $ne: null },
  };
  if (ids && ids.length > 0) {
    baseFilter.id = { $oneof: ids };
  }
  const { data: allTx } = await aqlQuery(
    q('transactions')
      .filter(baseFilter)
      .select([
        'id',
        'date',
        'amount',
        'notes',
        'imported_payee',
        'account',
        'payee',
        { payee_name: 'payee.name' },
        { account_name: 'account.name' },
      ])
      .orderBy({ date: 'desc' }),
  );

  // Group by (payee, amount) to find latest parcelado entry per purchase
  const parcByKey = new Map<string, Parcelado & { rawText: string }>();
  for (const t of allTx || []) {
    const sourceText = t.notes || t.imported_payee || '';
    const info = parseParcelInfo(sourceText);
    if (!info) continue;
    const key = `${t.payee}|${t.amount}|${info.total}`;
    if (!parcByKey.has(key)) {
      parcByKey.set(key, {
        txId: t.id,
        payeeId: t.payee,
        payeeName: t.payee_name || '?',
        accountId: t.account,
        accountName: t.account_name || '?',
        amount: t.amount,
        date: t.date,
        current: info.current,
        total: info.total,
        rawText: sourceText,
      });
    }
  }

  // Create one schedule per parcelado for the REMAINING installments
  let parceladaCreated = 0;
  const parceladasList = Array.from(parcByKey.values()).filter(
    p => p.current < p.total,
  );
  for (const p of parceladasList as Array<Parcelado & { rawText: string }>) {
    const remaining = p.total - p.current;
    if (remaining < 1) continue;

    const lastDate = new Date(p.date + 'T00:00:00');
    const nextDate = addMonthsClampDay(lastDate, 1);
    // Use the ORIGINAL transaction text (notes/imported_payee) verbatim as
    // the schedule name so it matches what the user sees in the cards. We
    // append a stable suffix to ensure uniqueness across re-runs and to be
    // able to derive the total parcelas count later.
    const purchaseMonth = addMonthsClampDay(lastDate, -(p.current - 1));
    const stableName = `${p.rawText.trim()} [parc=${p.total};desde=${purchaseMonth.toISOString().slice(0, 7)}]`;

    const safeAmount = Math.round(p.amount);
    logger.log(
      `[ai-detect] parcelada schedule for ${p.payeeName} amount=${safeAmount} (raw ${p.amount})`,
    );
    const conditions = [
      { op: 'is', field: 'account', value: p.accountId },
      { op: 'is', field: 'payee', value: p.payeeId },
      {
        op: 'isapprox',
        field: 'date',
        value: {
          start: ymdLocal(nextDate),
          frequency: 'monthly',
          interval: 1,
          endMode: 'after_n_occurrences',
          endOccurrences: remaining,
        },
      },
      { op: 'isapprox', field: 'amount', value: safeAmount },
    ];
    try {
      await createSchedule({
        schedule: { name: stableName },
        conditions,
      });
      parceladaCreated++;
    } catch (err) {
      // Likely "Cannot create schedules with the same name" — silently skip
      // duplicate parceladas that were already detected on a previous run.
      const msg = err instanceof Error ? err.message : String(err);
      if (!msg.includes('same name')) {
        logger.error('[ai-detect] failed parcelada schedule:', err);
      }
    }
  }

  // --- 2) Recorrentes via IA ------------------------------------------
  if (skipRecurring) {
    return {
      parceladas: {
        detected: parceladasList.length,
        created: parceladaCreated,
      },
      recurring: { detected: 0, created: 0 },
    };
  }
  // Send last 180 days of transactions to the AI for monthly-recurring
  // detection.
  const since = new Date(Date.now() - 180 * 86400000)
    .toISOString()
    .slice(0, 10);
  // Note: we DO NOT require payee != null. Many PIX/transfer-style payments
  // arrive without a normalized payee; we group those by imported_payee text
  // server-side.
  const { data: txForAi } = await aqlQuery(
    q('transactions')
      .filter({
        date: { $gte: since },
        is_parent: false,
        transfer_id: null,
        schedule: null,
      })
      .select([
        'id',
        'date',
        'amount',
        'account',
        'payee',
        'notes',
        'imported_payee',
        { payee_name: 'payee.name' },
        { category_name: 'category.name' },
        { category_group_name: 'category.group.name' },
      ])
      .orderBy({ date: 'asc' }),
  );

  let recurringDetected = 0;
  let recurringCreated = 0;
  if (txForAi && txForAi.length > 0) {
    try {
      const res = await post(
        serverConfig.BASE_SERVER + '/ai/detect-recurring',
        { transactions: txForAi },
        { 'X-ACTUAL-TOKEN': userToken },
      );
      const proposals = (res?.proposals || []) as Array<{
        payeeId: string;
        accountId: string;
        amount: number;
        nextDate: string;
        name?: string;
      }>;
      recurringDetected = proposals.length;
      for (const p of proposals) {
        if (!Number.isInteger(p.amount)) {
          p.amount = Math.round(
            Math.abs(p.amount) < 1 ? p.amount * 100 : p.amount,
          );
        }
        const safeAmount = p.amount;
        // If the server gave us a synthetic "needs-payee:<canonical>" id
        // (transactions without payee_id, e.g., PIX), materialize a real
        // payee now using the proposal's name as the payee name.
        let payeeIdToUse = p.payeeId;
        if (payeeIdToUse.startsWith('needs-payee:')) {
          const payeeName = (p.name || payeeIdToUse.replace('needs-payee:', ''))
            .trim()
            .slice(0, 100);
          try {
            // db.insertPayee returns the new payee id
            const newId = (await db.insertPayee({ name: payeeName })) as string;
            payeeIdToUse = newId;
            logger.log(`[ai-detect] created payee "${payeeName}" → ${newId}`);
          } catch (err) {
            logger.error('[ai-detect] failed to create payee:', err);
            continue;
          }
        }
        p.payeeId = payeeIdToUse;
        logger.log(
          `[ai-detect] recurring schedule for payee=${p.payeeId} amount=${safeAmount}`,
        );
        const conditions = [
          { op: 'is', field: 'account', value: p.accountId },
          { op: 'is', field: 'payee', value: p.payeeId },
          {
            op: 'isapprox',
            field: 'date',
            value: {
              start: p.nextDate,
              frequency: 'monthly',
              interval: 1,
              endMode: 'never',
            },
          },
          { op: 'isapprox', field: 'amount', value: safeAmount },
        ];
        // Use the most recent original transaction text for this payee as
        // the schedule name, so future predictions match what the user sees
        // in the imported card transactions.
        let repText = p.name || '?';
        try {
          const { data: lastTx } = await aqlQuery(
            q('transactions')
              .filter({ payee: p.payeeId, account: p.accountId })
              .orderBy({ date: 'desc' })
              .limit(1)
              .select(['notes', 'imported_payee']),
          );
          const t = (lastTx || [])[0] as
            | { notes?: string; imported_payee?: string }
            | undefined;
          repText = (t?.notes || t?.imported_payee || p.name || '?').trim();
        } catch {
          // fall back to AI name
        }
        const stableName = `${repText} [recorrente=mensal;valor=${p.amount}]`;
        try {
          await createSchedule({
            schedule: { name: stableName },
            conditions,
          });
          recurringCreated++;
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          if (!msg.includes('same name')) {
            logger.error('[ai-detect] failed recurring schedule:', err);
          }
        }
      }
    } catch (err) {
      logger.error('[ai-detect] AI call failed:', err);
    }
  }

  return {
    parceladas: { detected: parceladasList.length, created: parceladaCreated },
    recurring: { detected: recurringDetected, created: recurringCreated },
  };
}

async function deleteAllSchedules(): Promise<{ deleted: number }> {
  const { data: schedules } = await aqlQuery(
    q('schedules').filter({ tombstone: false }).select(['id']),
  );
  let deleted = 0;
  for (const s of (schedules || []) as Array<{ id: string }>) {
    try {
      await deleteSchedule({ id: s.id });
      deleted++;
    } catch (err) {
      logger.error('[ai] failed to delete schedule', s.id, err);
    }
  }
  return { deleted };
}

async function listAiLog({
  limit = 200,
}: {
  limit?: number;
} = {}): Promise<AiLogEntry[] | { error: string }> {
  const userToken = await asyncStorage.getItem('user-token');
  if (!userToken) return { error: 'not-logged-in' };

  const serverConfig = getServer();
  if (!serverConfig) return { error: 'no-server-configured' };

  const fileId = prefs.getPrefs()?.cloudFileId;
  if (!fileId) return { error: 'no-budget-loaded' };

  try {
    const result = await post(
      serverConfig.BASE_SERVER + '/ai/log',
      { fileId, limit },
      { 'X-ACTUAL-TOKEN': userToken },
    );
    return result;
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
}

export const app = createApp<AIHandlers>();
app.method('ai-insights', getInsights);
app.method('ai-insights-list', listInsights);
app.method('ai-insights-delete', deleteInsight);
app.method('ai-chat-send', sendChatMessage);
app.method('ai-chat-list', listChatMessages);
app.method('ai-chat-clear', clearChat);
app.method('ai-categorize-transactions', categorizeTransactions);
app.method('ai-auto-categorize-after-sync', autoCategorizeAfterSync);
app.method('ai-categorize-pending', categorizePending);
app.method('ai-cleanup-actual-ai-tags', cleanupActualAiTags);
app.method('ai-log-list', listAiLog);
app.method('ai-detect-and-create-schedules', detectAndCreateSchedules);
app.method('ai-delete-all-schedules', deleteAllSchedules);
