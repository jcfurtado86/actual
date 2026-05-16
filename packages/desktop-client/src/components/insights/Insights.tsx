import React, { useCallback, useEffect, useState } from 'react';
import { Trans, useTranslation } from 'react-i18next';

import { Button } from '@actual-app/components/button';
import { Select } from '@actual-app/components/select';
import { styles } from '@actual-app/components/styles';
import { Text } from '@actual-app/components/text';
import { theme } from '@actual-app/components/theme';
import { View } from '@actual-app/components/view';
import { send } from '@actual-app/core/platform/client/connection';

import { Page } from '#components/Page';

type InsightRecord = {
  id: string;
  generatedAt: string;
  lookbackDays: number;
  model: string;
  analyzed: number;
  tokens: { input: number; output: number } | null;
  html: string;
};

type MaybeError<T> = T | { error: string };

function isError<T extends object>(
  r: MaybeError<T> | null,
): r is {
  error: string;
} {
  return r !== null && 'error' in r;
}

const LOOKBACK_OPTIONS: Array<[string, string]> = [
  ['7', '7 dias'],
  ['14', '14 dias'],
  ['30', '30 dias'],
  ['60', '60 dias'],
  ['90', '90 dias'],
];

function formatDateTime(iso: string): string {
  try {
    return new Date(iso).toLocaleString('pt-BR', {
      day: '2-digit',
      month: '2-digit',
      year: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    });
  } catch {
    return iso;
  }
}

function translateError(code: string, t: (s: string) => string): string {
  switch (code) {
    case 'no-transactions':
      return t('Sem transações no período. Tente um intervalo maior.');
    case 'ai-not-configured':
      return t(
        'GOOGLE_API_KEY não configurada no servidor. Defina a variável de ambiente e reinicie.',
      );
    case 'not-logged-in':
      return t('Sessão expirada — faça login novamente.');
    case 'no-server-configured':
      return t('Servidor não configurado. Configure em Settings.');
    case 'no-budget-loaded':
      return t('Nenhum budget aberto.');
    default:
      return code;
  }
}

export function Insights() {
  const { t } = useTranslation();
  const [lookbackDays, setLookbackDays] = useState('30');
  const [loading, setLoading] = useState(false);
  const [generateError, setGenerateError] = useState<string | null>(null);
  const [history, setHistory] = useState<InsightRecord[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const refreshHistory = useCallback(async () => {
    const res = (await send('ai-insights-list', undefined)) as MaybeError<
      InsightRecord[]
    >;
    if (isError(res)) {
      setHistory([]);
      return;
    }
    setHistory(res);
    if (!selectedId && res.length > 0) {
      setSelectedId(res[0].id);
    }
  }, [selectedId]);

  useEffect(() => {
    void refreshHistory();
  }, [refreshHistory]);

  const generate = useCallback(async () => {
    setLoading(true);
    setGenerateError(null);
    try {
      const res = (await send('ai-insights', {
        lookbackDays: Number(lookbackDays),
      })) as MaybeError<InsightRecord>;
      if (isError(res)) {
        setGenerateError(res.error);
        return;
      }
      setSelectedId(res.id);
      await refreshHistory();
    } catch (err) {
      setGenerateError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [lookbackDays, refreshHistory]);

  const deleteEntry = useCallback(
    async (id: string) => {
      const res = (await send('ai-insights-delete', { id })) as MaybeError<
        InsightRecord[]
      >;
      if (!isError(res)) {
        setHistory(res);
        if (selectedId === id) {
          setSelectedId(res[0]?.id ?? null);
        }
      }
    },
    [selectedId],
  );

  const selected = history.find(r => r.id === selectedId) ?? null;

  return (
    <Page header={t('Insights')}>
      <View
        style={{ padding: '0 20px 20px 20px', gap: 16, flex: 1, minHeight: 0 }}
      >
        <View
          style={{
            flexDirection: 'row',
            alignItems: 'center',
            gap: 12,
            flexShrink: 0,
          }}
        >
          <Text>
            <Trans>Período:</Trans>
          </Text>
          <Select
            value={lookbackDays}
            onChange={setLookbackDays}
            options={LOOKBACK_OPTIONS}
            style={{ width: 140 }}
          />
          <Button variant="primary" isDisabled={loading} onPress={generate}>
            {loading ? t('Gerando…') : t('Gerar nova análise')}
          </Button>
          {selected?.tokens ? (
            <Text
              style={{
                fontSize: 11,
                color: theme.pageTextSubdued,
                marginLeft: 'auto',
              }}
            >
              {selected.model} · {selected.analyzed} transações ·{' '}
              {selected.tokens.input}+{selected.tokens.output} tokens
            </Text>
          ) : null}
        </View>

        {generateError && (
          <View
            style={{
              padding: 12,
              backgroundColor: theme.errorBackground,
              color: theme.errorText,
              borderRadius: 4,
              flexShrink: 0,
            }}
          >
            <Text style={{ fontWeight: 600 }}>
              <Trans>Erro:</Trans>{' '}
            </Text>
            <Text>{translateError(generateError, t)}</Text>
          </View>
        )}

        <View
          style={{
            flexDirection: 'row',
            gap: 16,
            flex: 1,
            minHeight: 0,
          }}
        >
          {/* History list */}
          <View
            style={{
              width: 240,
              flexShrink: 0,
              overflowY: 'auto',
              border: `1px solid ${theme.tableBorder}`,
              borderRadius: 6,
              backgroundColor: theme.tableBackground,
            }}
          >
            <View
              style={{
                padding: 12,
                borderBottom: `1px solid ${theme.tableBorder}`,
                fontWeight: 600,
                color: theme.pageTextSubdued,
                fontSize: 11,
                textTransform: 'uppercase',
                letterSpacing: 0.5,
              }}
            >
              <Trans>Histórico</Trans> ({history.length})
            </View>
            {history.length === 0 ? (
              <View
                style={{
                  padding: 16,
                  color: theme.pageTextSubdued,
                  fontSize: 13,
                }}
              >
                <Trans>Nenhum insight gerado ainda.</Trans>
              </View>
            ) : (
              history.map(record => (
                <View
                  key={record.id}
                  style={{
                    padding: 12,
                    borderBottom: `1px solid ${theme.tableBorder}`,
                    cursor: 'pointer',
                    backgroundColor:
                      selectedId === record.id
                        ? theme.tableRowBackgroundHighlight
                        : 'transparent',
                    flexDirection: 'row',
                    gap: 8,
                  }}
                  onClick={() => setSelectedId(record.id)}
                >
                  <View style={{ flex: 1, gap: 2 }}>
                    <Text style={{ fontWeight: 600, fontSize: 13 }}>
                      {formatDateTime(record.generatedAt)}
                    </Text>
                    <Text
                      style={{ fontSize: 11, color: theme.pageTextSubdued }}
                    >
                      {record.lookbackDays} dias · {record.analyzed} tx
                    </Text>
                  </View>
                  <Button
                    variant="bare"
                    aria-label={t('Excluir')}
                    onPress={() => {
                      void deleteEntry(record.id);
                    }}
                    style={{ padding: 2, fontSize: 14 }}
                  >
                    ×
                  </Button>
                </View>
              ))
            )}
          </View>

          {/* Viewer */}
          <View
            style={{
              flex: 1,
              minWidth: 0,
              overflowY: 'auto',
              padding: 24,
              backgroundColor: theme.tableBackground,
              borderRadius: 6,
              border: `1px solid ${theme.tableBorder}`,
            }}
          >
            {loading && (
              <View
                style={{
                  padding: 40,
                  alignItems: 'center',
                  color: theme.pageTextSubdued,
                }}
              >
                <Text>
                  <Trans>Gemini analisando suas transações…</Trans>
                </Text>
              </View>
            )}
            {!loading && !selected && (
              <View
                style={{
                  padding: 40,
                  alignItems: 'center',
                  color: theme.pageTextSubdued,
                }}
              >
                <Text>
                  <Trans>
                    Clique em &quot;Gerar nova análise&quot; ou selecione um
                    insight do histórico ao lado.
                  </Trans>
                </Text>
              </View>
            )}
            {!loading && selected && (
              <>
                <View
                  style={{
                    marginBottom: 12,
                    paddingBottom: 8,
                    borderBottom: `1px solid ${theme.tableBorder}`,
                    flexDirection: 'row',
                    alignItems: 'center',
                    gap: 12,
                  }}
                >
                  <Text
                    style={{
                      fontSize: 12,
                      color: theme.pageTextSubdued,
                    }}
                  >
                    {formatDateTime(selected.generatedAt)} ·{' '}
                    {selected.lookbackDays} dias · {selected.analyzed} tx
                  </Text>
                </View>
                <div
                  className="actual-ai-insights"
                  style={{
                    fontSize: 14,
                    lineHeight: 1.6,
                    color: styles.veryLargeText.color,
                  }}
                  dangerouslySetInnerHTML={{ __html: selected.html }}
                />
              </>
            )}
          </View>
        </View>
      </View>
    </Page>
  );
}
