import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { GoogleGenerativeAI } from '@google/generative-ai';
import express from 'express';
import type { Request, Response } from 'express';

import { config } from './load-config';
import {
  requestLoggerMiddleware,
  validateSessionMiddleware,
} from './util/middlewares';

const app = express();
app.use(requestLoggerMiddleware);
app.use(express.json({ limit: '10mb' }));
app.use(validateSessionMiddleware);

export { app as handlers };

const MAX_HISTORY = 50;
const MAX_LOG_ENTRIES = 500;

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

function logPath(fileId: string): string | null {
  const safeId = fileId.replace(/[^a-zA-Z0-9-]/g, '');
  if (!safeId) return null;
  return join(resolve(config.get('userFiles')), `ai-log-${safeId}.jsonl`);
}

function readLogRaw(fileId: string): AiLogEntry[] {
  const path = logPath(fileId);
  if (!path || !existsSync(path)) return [];
  try {
    const raw = readFileSync(path, 'utf8');
    return raw
      .split('\n')
      .filter(Boolean)
      .map(l => {
        try {
          return JSON.parse(l) as AiLogEntry;
        } catch {
          return null;
        }
      })
      .filter((e): e is AiLogEntry => e !== null);
  } catch {
    return [];
  }
}

function writeLogRaw(fileId: string, entries: AiLogEntry[]) {
  const path = logPath(fileId);
  if (!path) return;
  try {
    const trimmed = entries.slice(-MAX_LOG_ENTRIES);
    writeFileSync(path, trimmed.map(e => JSON.stringify(e)).join('\n') + '\n');
  } catch (err) {
    console.error('[ai-log] write failed:', err);
  }
}

function startLog(
  fileId: string | undefined | null,
  op: AiLogEntry['op'],
  summary?: string,
): string {
  const id = randomUUID();
  if (!fileId) return id;
  const entries = readLogRaw(fileId);
  entries.push({
    id,
    timestamp: new Date().toISOString(),
    op,
    status: 'running',
    summary,
  });
  writeLogRaw(fileId, entries);
  return id;
}

function completeLog(
  fileId: string | undefined | null,
  id: string,
  patch: Partial<AiLogEntry>,
) {
  if (!fileId) return;
  const entries = readLogRaw(fileId);
  const idx = entries.findIndex(e => e.id === id);
  if (idx === -1) return;
  entries[idx] = { ...entries[idx], ...patch };
  writeLogRaw(fileId, entries);
}

function readLog(fileId: string, limit = MAX_LOG_ENTRIES): AiLogEntry[] {
  return readLogRaw(fileId).slice(-limit).reverse();
}

type Transaction = {
  date: string;
  amount: number;
  payee_name?: string | null;
  category_name?: string | null;
  category_group?: string | null;
  account_name?: string | null;
  notes?: string | null;
};

type InsightsPayload = {
  fileId?: string;
  lookbackDays: number;
  currency?: string;
  transactions: Transaction[];
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

function historyPath(fileId: string): string | null {
  const safeId = fileId.replace(/[^a-zA-Z0-9-]/g, '');
  if (!safeId) return null;
  const baseDir = resolve(config.get('userFiles'));
  return join(baseDir, `ai-insights-${safeId}.json`);
}

function readHistory(fileId: string): InsightRecord[] {
  const path = historyPath(fileId);
  if (!path || !existsSync(path)) return [];
  try {
    const raw = readFileSync(path, 'utf8');
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch (err) {
    console.error(`[ai/insights] failed to read history: ${err}`);
    return [];
  }
}

function appendHistory(fileId: string, record: InsightRecord) {
  const path = historyPath(fileId);
  if (!path) return;
  try {
    const list = readHistory(fileId);
    list.unshift(record);
    const trimmed = list.slice(0, MAX_HISTORY);
    writeFileSync(path, JSON.stringify(trimmed, null, 2));
  } catch (err) {
    console.error(`[ai/insights] failed to write history: ${err}`);
  }
}

function buildPrompt(payload: InsightsPayload): string {
  const { lookbackDays, transactions, currency = 'R$' } = payload;

  const totalSpent = transactions
    .filter(t => t.amount < 0)
    .reduce((sum, t) => sum + -t.amount, 0);

  const byCategory: Record<string, number> = {};
  for (const t of transactions) {
    if (t.amount >= 0) continue;
    const key = t.category_name || '(sem categoria)';
    byCategory[key] = (byCategory[key] || 0) + -t.amount;
  }

  const catTotals = Object.entries(byCategory)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 15)
    .map(
      ([cat, val]) =>
        `${cat}: ${currency} ${(val / 100).toFixed(2).replace('.', ',')}`,
    )
    .join('\n');

  const txLines = transactions
    .map(t => {
      const amount = (t.amount / 100).toFixed(2).replace('.', ',');
      const cat = t.category_name || '(sem categoria)';
      const payee = t.payee_name || '?';
      const acc = t.account_name || '?';
      const notes = t.notes ? ` | ${t.notes}` : '';
      return `${t.date} | ${acc} | ${cat} | ${payee} | ${currency} ${amount}${notes}`;
    })
    .join('\n');

  return `Você é um consultor financeiro pessoal honesto, direto e prático. Analise os gastos dos últimos ${lookbackDays} dias e gere um relatório útil.

Contexto:
- Total gasto no período: ${currency} ${(totalSpent / 100).toFixed(2).replace('.', ',')}
- Total de transações: ${transactions.length}

Totais por categoria (top 15):
${catTotals}

Transações detalhadas:
${txLines}

Produza um relatório em HTML curto (use <h2>, <h3>, <p>, <ul>, <li>, <strong>; SEM CSS, SEM <html>/<body>), com EXATAMENTE estas seções:

<h2>Resumo</h2>
1-2 parágrafos com o panorama: total e as principais categorias.

<h2>Padrões interessantes</h2>
3-5 bullets com observações concretas baseadas nos dados reais (ex: número de visitas a um payee, gasto que dobrou, recorrência identificada).

<h2>Sugestões de corte</h2>
3 sugestões CONCRETAS e ACIONÁVEIS, com valor estimado de economia mensal calculado a partir das transações reais. NÃO invente regras genéricas — baseie em transações listadas acima.

<h2>Gastos atípicos</h2>
0-3 transações fora do padrão (valor alto, payee desconhecido, frequência anormal). Se nada chamou atenção, escreva "Nada chamou atenção nesse período."

<h2>Próxima ação</h2>
UMA ação clara que o usuário pode fazer hoje.

Regras:
- Português brasileiro, tom direto.
- Sem disclaimers ("isso não é aconselhamento financeiro" etc).
- Sem repetir os dados crus que recebeu.
- Valores em ${currency} com 2 decimais, vírgula como separador decimal.`;
}

app.post('/insights', async (req: Request, res: Response) => {
  const apiKey = process.env.GOOGLE_API_KEY;
  if (!apiKey) {
    res.status(503).send({
      status: 'error',
      reason: 'ai-not-configured',
      details: 'GOOGLE_API_KEY env var not set on the server',
    });
    return;
  }

  const payload = req.body as InsightsPayload;
  if (
    !payload ||
    !Array.isArray(payload.transactions) ||
    payload.transactions.length === 0
  ) {
    res.status(400).send({
      status: 'error',
      reason: 'no-transactions',
    });
    return;
  }

  const t0 = Date.now();
  const logId = startLog(
    payload.fileId,
    'insights',
    `${payload.lookbackDays}d, ${payload.transactions.length} tx`,
  );
  try {
    const modelName = process.env.GEMINI_MODEL || 'gemini-2.5-flash';
    const genai = new GoogleGenerativeAI(apiKey);
    const model = genai.getGenerativeModel({ model: modelName });

    const prompt = buildPrompt(payload);
    console.log(
      `[ai/insights] calling ${modelName} with ${payload.transactions.length} tx, ${prompt.length} chars`,
    );
    const result = await model.generateContent(prompt);
    const html = result.response.text();
    const usage = result.response.usageMetadata;
    console.log(
      `[ai/insights] ${modelName} returned ${html.length} chars` +
        (usage
          ? `, tokens ${usage.promptTokenCount}+${usage.candidatesTokenCount}`
          : ''),
    );

    const record: InsightRecord = {
      id: randomUUID(),
      generatedAt: new Date().toISOString(),
      lookbackDays: payload.lookbackDays,
      model: modelName,
      analyzed: payload.transactions.length,
      tokens: usage
        ? {
            input: usage.promptTokenCount,
            output: usage.candidatesTokenCount,
          }
        : null,
      html,
    };

    if (payload.fileId) {
      appendHistory(payload.fileId, record);
    }

    completeLog(payload.fileId, logId, {
      status: 'ok',
      model: modelName,
      durationMs: Date.now() - t0,
      tokens: record.tokens,
      summary: `${payload.lookbackDays}d, ${payload.transactions.length} tx → ${html.length} chars`,
    });

    res.send({ status: 'ok', data: record });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[ai/insights] error: ${message}`);
    completeLog(payload.fileId, logId, {
      status: 'error',
      durationMs: Date.now() - t0,
      error: message,
    });
    res
      .status(500)
      .send({ status: 'error', reason: 'ai-call-failed', details: message });
  }
});

app.post('/insights/list', async (req: Request, res: Response) => {
  const { fileId } = (req.body as { fileId?: string }) || {};
  if (!fileId) {
    res.status(400).send({ status: 'error', reason: 'missing-file-id' });
    return;
  }
  const list = readHistory(fileId);
  res.send({ status: 'ok', data: list });
});

app.post('/insights/delete', async (req: Request, res: Response) => {
  const { fileId, id } = (req.body as { fileId?: string; id?: string }) || {};
  if (!fileId || !id) {
    res.status(400).send({ status: 'error', reason: 'missing-args' });
    return;
  }
  const path = historyPath(fileId);
  if (!path || !existsSync(path)) {
    res.send({ status: 'ok', data: [] });
    return;
  }
  const list = readHistory(fileId).filter(r => r.id !== id);
  writeFileSync(path, JSON.stringify(list, null, 2));
  res.send({ status: 'ok', data: list });
});

// ====================================================================
// Chat
// ====================================================================

type ChatMessage = {
  role: 'user' | 'assistant';
  content: string;
  timestamp: string;
  model?: string;
  tokens?: { input: number; output: number };
};

type ChatPayload = {
  fileId?: string;
  message: string;
  contextData?: {
    asOfDate?: string;
    accounts?: Array<{ name: string; offbudget?: boolean }>;
    categories?: Array<{ name: string; group?: string }>;
    transactions?: Transaction[];
  };
};

function chatPath(fileId: string): string | null {
  const safeId = fileId.replace(/[^a-zA-Z0-9-]/g, '');
  if (!safeId) return null;
  return join(resolve(config.get('userFiles')), `ai-chat-${safeId}.json`);
}

function readChat(fileId: string): ChatMessage[] {
  const path = chatPath(fileId);
  if (!path || !existsSync(path)) return [];
  try {
    const raw = readFileSync(path, 'utf8');
    const parsed = JSON.parse(raw) as { messages?: ChatMessage[] };
    return Array.isArray(parsed?.messages) ? parsed.messages : [];
  } catch {
    return [];
  }
}

function writeChat(fileId: string, messages: ChatMessage[]) {
  const path = chatPath(fileId);
  if (!path) return;
  // Keep only the last 200 messages to avoid runaway growth
  const trimmed = messages.slice(-200);
  writeFileSync(path, JSON.stringify({ messages: trimmed }, null, 2));
}

function buildChatSystemPrompt(
  ctx: NonNullable<ChatPayload['contextData']>,
): string {
  const lines: string[] = [];
  lines.push(
    'Você é um consultor financeiro pessoal embarcado em um app de orçamento. ' +
      'Responde em português brasileiro, tom direto e útil. Sem disclaimers ' +
      '("não sou consultor"). Sem inventar dados — se a informação não está no ' +
      'contexto abaixo, diga isso. Valores em R$ com vírgula como decimal. ' +
      'Use HTML simples (h3, p, ul, li, strong) quando faz sentido pra estrutura, ' +
      'caso contrário responda em texto corrido.',
  );

  if (ctx.asOfDate) lines.push(`\nData de referência: ${ctx.asOfDate}`);

  if (ctx.accounts && ctx.accounts.length) {
    lines.push('\nContas do usuário:');
    for (const a of ctx.accounts) {
      const off = a.offbudget ? ' [fora do orçamento]' : '';
      lines.push(`- ${a.name}${off}`);
    }
  }

  if (ctx.categories && ctx.categories.length) {
    lines.push('\nCategorias disponíveis:');
    const byGroup: Record<string, string[]> = {};
    for (const c of ctx.categories) {
      const g = c.group || '(sem grupo)';
      (byGroup[g] = byGroup[g] || []).push(c.name);
    }
    for (const [g, names] of Object.entries(byGroup)) {
      lines.push(`- ${g}: ${names.join(', ')}`);
    }
  }

  if (ctx.transactions && ctx.transactions.length) {
    lines.push(
      `\nTransações dos últimos meses (${ctx.transactions.length} registros, formato: data | conta | categoria | payee | valor):`,
    );
    for (const t of ctx.transactions) {
      const amount = (t.amount / 100).toFixed(2).replace('.', ',');
      const cat = t.category_name || '(sem categoria)';
      const payee = t.payee_name || '?';
      const acc = t.account_name || '?';
      lines.push(`${t.date} | ${acc} | ${cat} | ${payee} | R$ ${amount}`);
    }
  }

  return lines.join('\n');
}

app.post('/chat/send', async (req: Request, res: Response) => {
  const apiKey = process.env.GOOGLE_API_KEY;
  if (!apiKey) {
    res.status(503).send({
      status: 'error',
      reason: 'ai-not-configured',
      details: 'GOOGLE_API_KEY env var not set on the server',
    });
    return;
  }

  const payload = req.body as ChatPayload;
  if (!payload?.fileId) {
    res.status(400).send({ status: 'error', reason: 'missing-file-id' });
    return;
  }
  if (!payload.message?.trim()) {
    res.status(400).send({ status: 'error', reason: 'empty-message' });
    return;
  }

  const messages = readChat(payload.fileId);
  const userMsg: ChatMessage = {
    role: 'user',
    content: payload.message.trim(),
    timestamp: new Date().toISOString(),
  };

  const t0 = Date.now();
  const logId = startLog(
    payload.fileId,
    'chat',
    `prompt "${userMsg.content.slice(0, 60)}${userMsg.content.length > 60 ? '…' : ''}"`,
  );
  try {
    const modelName = process.env.GEMINI_MODEL || 'gemini-2.5-flash';
    const genai = new GoogleGenerativeAI(apiKey);
    const systemInstruction = buildChatSystemPrompt(payload.contextData || {});
    const model = genai.getGenerativeModel({
      model: modelName,
      systemInstruction,
    });

    // Build conversation history for Gemini. Last 30 turns kept in prompt.
    const history = messages.slice(-30).map(m => ({
      role: m.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: m.content }],
    }));

    const chat = model.startChat({ history });

    console.log(
      `[ai/chat] calling ${modelName} with ${messages.length} prior msgs, system prompt ${systemInstruction.length} chars`,
    );
    const result = await chat.sendMessage(userMsg.content);
    const text = result.response.text();
    const usage = result.response.usageMetadata;
    console.log(
      `[ai/chat] ${modelName} returned ${text.length} chars` +
        (usage
          ? `, tokens ${usage.promptTokenCount}+${usage.candidatesTokenCount}`
          : ''),
    );

    const assistantMsg: ChatMessage = {
      role: 'assistant',
      content: text,
      timestamp: new Date().toISOString(),
      model: modelName,
      tokens: usage
        ? {
            input: usage.promptTokenCount,
            output: usage.candidatesTokenCount,
          }
        : undefined,
    };

    const updated = [...messages, userMsg, assistantMsg];
    writeChat(payload.fileId, updated);

    completeLog(payload.fileId, logId, {
      status: 'ok',
      model: modelName,
      durationMs: Date.now() - t0,
      tokens: assistantMsg.tokens || null,
      summary: `${messages.length + 2} msg, "${userMsg.content.slice(0, 60)}${userMsg.content.length > 60 ? '…' : ''}"`,
    });

    res.send({
      status: 'ok',
      data: { messages: updated, latest: assistantMsg },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[ai/chat] error: ${message}`);
    completeLog(payload.fileId, logId, {
      status: 'error',
      durationMs: Date.now() - t0,
      error: message,
    });
    res
      .status(500)
      .send({ status: 'error', reason: 'chat-call-failed', details: message });
  }
});

app.post('/chat/list', async (req: Request, res: Response) => {
  const { fileId } = (req.body as { fileId?: string }) || {};
  if (!fileId) {
    res.status(400).send({ status: 'error', reason: 'missing-file-id' });
    return;
  }
  res.send({ status: 'ok', data: { messages: readChat(fileId) } });
});

// ====================================================================
// Categorize
// ====================================================================

type CategorizePayload = {
  transactions: Array<{
    id: string;
    date: string;
    amount: number;
    payee_name?: string | null;
    imported_payee?: string | null;
    notes?: string | null;
    current_category_name?: string | null;
  }>;
  categories: Array<{
    id: string;
    name: string;
    group?: string | null;
  }>;
};

function extractJsonArray(text: string): unknown[] {
  // Gemini sometimes wraps JSON in code fences; strip them.
  let cleaned = text.trim();
  cleaned = cleaned.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '');
  // Find first [ and last ]
  const start = cleaned.indexOf('[');
  const end = cleaned.lastIndexOf(']');
  if (start === -1 || end === -1 || end < start) return [];
  try {
    const parsed = JSON.parse(cleaned.slice(start, end + 1));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

app.post('/categorize', async (req: Request, res: Response) => {
  const apiKey = process.env.GOOGLE_API_KEY;
  if (!apiKey) {
    res.status(503).send({
      status: 'error',
      reason: 'ai-not-configured',
    });
    return;
  }

  const payload = req.body as CategorizePayload & {
    fileId?: string;
    auto?: boolean;
  };
  const t0 = Date.now();
  const logId = startLog(
    payload.fileId,
    payload.auto ? 'auto-categorize' : 'categorize',
    `${payload?.transactions?.length || 0} tx`,
  );
  if (
    !Array.isArray(payload?.transactions) ||
    payload.transactions.length === 0
  ) {
    res.status(400).send({ status: 'error', reason: 'no-transactions' });
    return;
  }
  if (!Array.isArray(payload.categories) || payload.categories.length === 0) {
    res.status(400).send({ status: 'error', reason: 'no-categories' });
    return;
  }

  const catLines = payload.categories
    .map(c => `- ${c.id} | ${c.name}${c.group ? ` (${c.group})` : ''}`)
    .join('\n');

  const txLines = payload.transactions
    .map(t => {
      const amount = (t.amount / 100).toFixed(2).replace('.', ',');
      const payee = t.payee_name || t.imported_payee || '?';
      const notes = t.notes ? ` | notas: ${t.notes}` : '';
      const curCat = t.current_category_name
        ? ` | atual: ${t.current_category_name}`
        : '';
      return `- ${t.id} | ${t.date} | ${payee} | R$ ${amount}${notes}${curCat}`;
    })
    .join('\n');

  const prompt = `Você categoriza transações financeiras de um usuário brasileiro.

Categorias disponíveis (formato: categoryId | nome | grupo):
${catLines}

Transações para categorizar (formato: transactionId | data | payee | valor):
${txLines}

Para cada transação, escolha o categoryId mais apropriado entre os disponíveis. Use o nome do payee como sinal principal. Considere o grupo da categoria.

Responda APENAS com um array JSON no formato:
[
  {"transactionId": "abc", "categoryId": "xyz", "confidence": "high|medium|low"},
  ...
]

Regras:
- Use APENAS categoryIds que existem na lista acima.
- Se não houver categoria adequada, omita a transação do resultado.
- confidence: "high" se óbvio (ex: iFood → Alimentação), "medium" se inferido por padrão, "low" se chute educado.
- Não inclua nada além do JSON. Sem markdown, sem texto explicativo.`;

  try {
    const modelName = process.env.GEMINI_MODEL || 'gemini-2.5-flash';
    const genai = new GoogleGenerativeAI(apiKey);
    const model = genai.getGenerativeModel({
      model: modelName,
      generationConfig: {
        responseMimeType: 'application/json',
        maxOutputTokens: 32768,
      },
    });

    console.log(
      `[ai/categorize] calling ${modelName} with ${payload.transactions.length} tx and ${payload.categories.length} cats`,
    );
    const result = await model.generateContent(prompt);
    const text = result.response.text();
    const usage = result.response.usageMetadata;
    console.log(
      `[ai/categorize] ${modelName} returned ${text.length} chars` +
        (usage
          ? `, tokens ${usage.promptTokenCount}+${usage.candidatesTokenCount}`
          : ''),
    );

    const validCategoryIds = new Set(payload.categories.map(c => c.id));
    const validTransactionIds = new Set(payload.transactions.map(t => t.id));
    const raw = extractJsonArray(text);
    console.log(
      `[ai/categorize] parsed ${raw.length} raw suggestions from JSON`,
    );
    if (raw.length > 0) {
      console.log(`[ai/categorize] sample raw: ${JSON.stringify(raw[0])}`);
    }
    const wellFormed = raw.filter(
      (
        s,
      ): s is {
        transactionId: string;
        categoryId: string;
        confidence?: string;
      } =>
        typeof s === 'object' &&
        s !== null &&
        typeof (s as { transactionId?: unknown }).transactionId === 'string' &&
        typeof (s as { categoryId?: unknown }).categoryId === 'string',
    );
    const suggestions = wellFormed.filter(
      s =>
        validTransactionIds.has(s.transactionId) &&
        validCategoryIds.has(s.categoryId),
    );
    console.log(
      `[ai/categorize] ${wellFormed.length} well-formed → ${suggestions.length} valid (dropped ${wellFormed.length - suggestions.length} due to unknown ids)`,
    );
    if (wellFormed.length > 0 && suggestions.length === 0) {
      const bad = wellFormed[0];
      console.log(
        `[ai/categorize] sample rejected: tx=${bad.transactionId} (valid=${validTransactionIds.has(bad.transactionId)}) cat=${bad.categoryId} (valid=${validCategoryIds.has(bad.categoryId)})`,
      );
      console.log(
        `[ai/categorize] sample real tx id: ${payload.transactions[0]?.id}, real cat id: ${payload.categories[0]?.id}`,
      );
    }

    const tokens = usage
      ? {
          input: usage.promptTokenCount,
          output: usage.candidatesTokenCount,
        }
      : null;

    completeLog(payload.fileId, logId, {
      status: 'ok',
      model: modelName,
      durationMs: Date.now() - t0,
      tokens,
      summary: `${payload.transactions.length} tx → ${suggestions.length} sugestões`,
    });

    res.send({
      status: 'ok',
      data: {
        suggestions,
        model: modelName,
        tokens,
      },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[ai/categorize] error: ${message}`);
    completeLog(payload.fileId, logId, {
      status: 'error',
      durationMs: Date.now() - t0,
      error: message,
    });
    res
      .status(500)
      .send({ status: 'error', reason: 'ai-call-failed', details: message });
  }
});

// ====================================================================
// Recurring detection
// ====================================================================

type DetectRecurringPayload = {
  transactions: Array<{
    id: string;
    date: string;
    amount: number;
    account: string;
    payee: string;
    payee_name?: string | null;
    notes?: string | null;
    imported_payee?: string | null;
    category_name?: string | null;
    category_group_name?: string | null;
  }>;
};

const MIN_RECURRING_AMOUNT_CENTS = 1500; // R$ 15
const FOOD_KEYWORDS = [
  'aliment',
  'comida',
  'restaur',
  'mercado',
  'delivery',
  'food',
  'lanche',
  'padaria',
  'cafe',
  'café',
  'supermerc',
];

function isFoodCategory(name: string | null | undefined): boolean {
  if (!name) return false;
  const n = name.toLowerCase();
  return FOOD_KEYWORDS.some(k => n.includes(k));
}

app.post('/detect-recurring', async (req: Request, res: Response) => {
  const payload = req.body as DetectRecurringPayload;
  if (
    !Array.isArray(payload?.transactions) ||
    payload.transactions.length === 0
  ) {
    res.status(400).send({ status: 'error', reason: 'no-transactions' });
    return;
  }

  // Group by payee_id when present; otherwise group by a normalized title
  // so PIX/transfer-style payments without payee_id can still be detected.
  // Groups without payee_id will be flagged with a synthetic payeeId
  // ("needs-payee:<canonical>") for the loot-core handler to materialize a
  // real payee before creating the schedule.
  function canonicalize(text: string): string {
    return text
      .toLowerCase()
      .replace(/[^a-z0-9 ]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 60);
  }
  type Group = {
    payeeId: string;
    accountId: string;
    payeeName: string;
    items: Array<{ date: string; amount: number; text: string }>;
    needsPayee: boolean;
  };
  const groups = new Map<string, Group>();
  for (const t of payload.transactions) {
    // Filter out income (positive amounts), tiny amounts (< R$ 15) and food
    // categories — user request.
    if (t.amount >= 0) continue;
    if (Math.abs(t.amount) < MIN_RECURRING_AMOUNT_CENTS) continue;
    if (
      isFoodCategory(t.category_name) ||
      isFoodCategory(t.category_group_name)
    ) {
      continue;
    }

    const text = (t.notes || t.imported_payee || '').slice(0, 80);
    let payeeKey: string;
    let payeeName: string;
    let needsPayee = false;
    if (t.payee) {
      payeeKey = t.payee;
      payeeName = t.payee_name || '?';
    } else {
      const canon = canonicalize(text);
      if (!canon) continue;
      payeeKey = `needs-payee:${canon}`;
      payeeName = text || canon;
      needsPayee = true;
    }
    const key = `${payeeKey}|${t.account}`;
    if (!groups.has(key)) {
      groups.set(key, {
        payeeId: payeeKey,
        accountId: t.account,
        payeeName,
        items: [],
        needsPayee,
      });
    }
    groups.get(key)!.items.push({ date: t.date, amount: t.amount, text });
  }

  // Pre-filter: candidates have at least 3 occurrences within 6 months
  const candidates = Array.from(groups.values()).filter(
    g => g.items.length >= 3,
  );
  if (candidates.length === 0) {
    res.send({ status: 'ok', data: { proposals: [] } });
    return;
  }

  // -- Pass A: Algorithmic detection ------------------------------------
  // Lenient: average gap between consecutive dates in [20, 55] days AND
  // amount max/min ≤ 1.5. Doesn't try to be perfect — catches the common
  // monthly cases.
  type Proposal = {
    payeeId: string;
    accountId: string;
    amount: number;
    nextDate: string;
    name?: string;
  };
  const proposalsByPayee = new Map<string, Proposal>();

  for (const g of candidates) {
    const items = [...g.items].sort((a, b) => a.date.localeCompare(b.date));
    if (items.length < 3) {
      console.log(
        `[detect-recurring] SKIP ${g.payeeName}: only ${items.length} items`,
      );
      continue;
    }

    let gapSum = 0;
    for (let i = 1; i < items.length; i++) {
      gapSum +=
        (new Date(items[i].date).getTime() -
          new Date(items[i - 1].date).getTime()) /
        86400000;
    }
    const avgGap = gapSum / (items.length - 1);
    if (avgGap < 20 || avgGap > 55) {
      console.log(
        `[detect-recurring] SKIP ${g.payeeName}: avgGap=${avgGap.toFixed(1)}d (need 20-55)`,
      );
      continue;
    }

    const amounts = items.map(i => Math.abs(i.amount));
    const minA = Math.min(...amounts);
    const maxA = Math.max(...amounts);
    if (minA > 0 && maxA / minA > 1.5) {
      console.log(
        `[detect-recurring] SKIP ${g.payeeName}: amount variance ${(maxA / minA).toFixed(2)} > 1.5`,
      );
      continue;
    }

    // Use the LAST occurrence's amount (most recent), not the average —
    // matches user expectation that the schedule should reflect the current
    // billing.
    const last = items[items.length - 1];
    const lastDate = new Date(last.date);
    const nextDate = new Date(lastDate.getTime() + 30 * 86400000);
    console.log(
      `[detect-recurring] OK ${g.payeeName}: ${items.length} items, avgGap=${avgGap.toFixed(1)}d, amount=${last.amount}`,
    );
    proposalsByPayee.set(g.payeeId, {
      payeeId: g.payeeId,
      accountId: g.accountId,
      amount: last.amount,
      nextDate: nextDate.toISOString().slice(0, 10),
      name: g.payeeName,
    });
  }
  // Also list candidates that are below the 3-item threshold so we can spot
  // why payees with only 2 visible txs (e.g., out of date window) didn't
  // qualify.
  for (const g of groups.values()) {
    if (g.items.length < 3) {
      console.log(
        `[detect-recurring] BELOW THRESHOLD ${g.payeeName}: ${g.items.length} items in window`,
      );
    }
  }

  // -- Pass B: AI fallback for candidates not caught by algorithm --------
  const apiKey = process.env.GOOGLE_API_KEY;
  const remaining = candidates.filter(g => !proposalsByPayee.has(g.payeeId));
  if (apiKey && remaining.length > 0) {
    const groupLines = remaining
      .map(g => {
        const lines = g.items
          .map(i => {
            const v = (i.amount / 100).toFixed(2).replace('.', ',');
            return `    ${i.date} | R$ ${v} | "${i.text}"`;
          })
          .join('\n');
        return `[${g.payeeId}] ${g.payeeName} (${g.items.length}x):\n${lines}`;
      })
      .join('\n\n');
    const prompt = `Identifique pagamentos RECORRENTES entre estes payees (qualquer cadência mensal: assinaturas, contas, pagamento a pessoas, tarifas bancárias, etc).

${groupLines}

Seja generoso: 3+ ocorrências mensais com mesmo payee SÃO recorrentes, mesmo se for pessoa física ("WULISSES"), banco ("Santander"), etc. Variações de valor até 50% são normais.

EXCLUA apenas: compras únicas, parceladas com "PARC X/Y", transferências.

Retorne array JSON:
[{"payeeId":"<id>","amount":-2990,"nextDate":"YYYY-MM-DD","name":"<rótulo>"}]`;

    try {
      const modelName = process.env.GEMINI_MODEL || 'gemini-2.5-flash';
      const genai = new GoogleGenerativeAI(apiKey);
      const model = genai.getGenerativeModel({
        model: modelName,
        generationConfig: { responseMimeType: 'application/json' },
      });
      const result = await model.generateContent(prompt);
      const text = result.response.text();
      const validPayees = new Map(remaining.map(g => [g.payeeId, g]));
      for (const p of extractJsonArray(text)) {
        if (
          typeof p === 'object' &&
          p !== null &&
          typeof (p as { payeeId?: unknown }).payeeId === 'string' &&
          typeof (p as { amount?: unknown }).amount === 'number' &&
          typeof (p as { nextDate?: unknown }).nextDate === 'string'
        ) {
          const tp = p as {
            payeeId: string;
            amount: number;
            nextDate: string;
            name?: string;
          };
          const g = validPayees.get(tp.payeeId);
          if (!g) continue;
          if (proposalsByPayee.has(tp.payeeId)) continue;
          // Use the LAST occurrence's amount (matches user expectation).
          const sortedItems = [...g.items].sort((a, b) =>
            a.date.localeCompare(b.date),
          );
          const lastItem = sortedItems[sortedItems.length - 1];
          const amountCents = lastItem.amount;
          proposalsByPayee.set(tp.payeeId, {
            payeeId: tp.payeeId,
            accountId: g.accountId,
            amount: amountCents,
            nextDate: tp.nextDate,
            name: tp.name || g.payeeName,
          });
        }
      }
    } catch (err) {
      console.error('[ai/detect-recurring] AI fallback failed:', err);
    }
  }

  const proposals = Array.from(proposalsByPayee.values());
  console.log(
    `[ai/detect-recurring] ${candidates.length} candidates → ${proposals.length} recurring (algo+AI union)`,
  );
  res.send({ status: 'ok', data: { proposals } });
});

app.post('/log', async (req: Request, res: Response) => {
  const { fileId, limit } =
    (req.body as {
      fileId?: string;
      limit?: number;
    }) || {};
  if (!fileId) {
    res.status(400).send({ status: 'error', reason: 'missing-file-id' });
    return;
  }
  res.send({ status: 'ok', data: readLog(fileId, limit) });
});

app.post('/chat/clear', async (req: Request, res: Response) => {
  const { fileId } = (req.body as { fileId?: string }) || {};
  if (!fileId) {
    res.status(400).send({ status: 'error', reason: 'missing-file-id' });
    return;
  }
  const path = chatPath(fileId);
  if (path && existsSync(path)) {
    writeFileSync(path, JSON.stringify({ messages: [] }, null, 2));
  }
  res.send({ status: 'ok', data: { messages: [] } });
});
