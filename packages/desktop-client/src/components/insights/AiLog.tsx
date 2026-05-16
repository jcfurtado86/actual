import React, { useCallback, useEffect, useState } from 'react';
import { Trans, useTranslation } from 'react-i18next';

import { Button } from '@actual-app/components/button';
import { SvgNotesPaperText } from '@actual-app/components/icons/v2';
import { Text } from '@actual-app/components/text';
import { theme } from '@actual-app/components/theme';
import { View } from '@actual-app/components/view';
import { send } from '@actual-app/core/platform/client/connection';

import { useDraggable } from '#hooks/useDraggable';

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

type MaybeError<T> = T | { error: string };

function isError<T extends object>(
  r: MaybeError<T> | null,
): r is {
  error: string;
} {
  return r !== null && 'error' in r;
}

const OP_COLORS: Record<AiLogEntry['op'], string> = {
  insights: '#7c3aed',
  chat: '#0ea5e9',
  categorize: '#10b981',
  'auto-categorize': '#059669',
};

function Entry({ e }: { e: AiLogEntry }) {
  const isRunning = e.status === 'running';
  return (
    <View
      style={{
        padding: '8px 14px',
        borderBottom: `1px solid ${theme.tableBorder}`,
        fontSize: 12,
        gap: 2,
        backgroundColor: isRunning
          ? theme.tableRowBackgroundHighlight
          : 'transparent',
      }}
    >
      <View
        style={{
          flexDirection: 'row',
          gap: 8,
          alignItems: 'center',
        }}
      >
        <Text
          style={{
            color: OP_COLORS[e.op] || theme.pageText,
            fontWeight: 600,
            fontSize: 10,
            textTransform: 'uppercase',
            letterSpacing: 0.3,
            width: 110,
            flexShrink: 0,
          }}
        >
          {e.op}
        </Text>
        <Text
          style={{
            color:
              e.status === 'ok'
                ? theme.noticeText
                : e.status === 'error'
                  ? theme.errorText
                  : '#d97706',
            fontSize: 10,
            fontWeight: 600,
            textTransform: 'uppercase',
            width: 60,
            flexShrink: 0,
          }}
        >
          {isRunning ? '⏳ running' : e.status}
        </Text>
        <Text
          style={{
            color: theme.pageTextSubdued,
            fontSize: 11,
            marginLeft: 'auto',
          }}
        >
          {new Date(e.timestamp).toLocaleString('pt-BR', {
            day: '2-digit',
            month: '2-digit',
            hour: '2-digit',
            minute: '2-digit',
            second: '2-digit',
          })}
        </Text>
      </View>
      <Text style={{ color: theme.pageText, fontSize: 12 }}>
        {e.summary || e.error || (isRunning ? 'Aguardando resposta…' : '—')}
      </Text>
      {!isRunning && (
        <Text style={{ color: theme.pageTextSubdued, fontSize: 10 }}>
          {e.model && `${e.model} · `}
          {e.durationMs != null && `${e.durationMs}ms`}
          {e.tokens && ` · ${e.tokens.input}+${e.tokens.output} tokens`}
        </Text>
      )}
    </View>
  );
}

const PANEL_WIDTH = 520;
const PANEL_HEIGHT = 640;

export function AiLog() {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const { pos, handleProps } = useDraggable();
  const [entries, setEntries] = useState<AiLogEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [cleanupMsg, setCleanupMsg] = useState<string | null>(null);
  const [cleaningTags, setCleaningTags] = useState(false);
  const [detectMsg, setDetectMsg] = useState<string | null>(null);
  const [detecting, setDetecting] = useState(false);

  const refresh = useCallback(async () => {
    const res = (await send('ai-log-list', { limit: 500 })) as MaybeError<
      AiLogEntry[]
    >;
    if (isError(res)) {
      setError(res.error);
      setEntries([]);
    } else {
      setError(null);
      setEntries(res);
    }
  }, []);

  useEffect(() => {
    if (!open) return;
    void refresh();
    const id = setInterval(() => {
      void refresh();
    }, 3000);
    return () => clearInterval(id);
  }, [open, refresh]);

  const onDeleteAllSchedules = useCallback(async () => {
    if (
      !window.confirm(
        'Apagar TODOS os schedules existentes? Útil pra recomeçar a detecção do zero.',
      )
    ) {
      return;
    }
    setDetecting(true);
    setDetectMsg('Apagando…');
    try {
      const res = (await send('ai-delete-all-schedules', undefined)) as {
        deleted: number;
      };
      setDetectMsg(`Apagados ${res.deleted} schedules.`);
    } catch (err) {
      setDetectMsg(`Erro: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setDetecting(false);
    }
  }, []);

  const onDetectSchedules = useCallback(async () => {
    if (
      !window.confirm(
        'Detectar parceladas e cobranças recorrentes e criar Schedules automaticamente?',
      )
    ) {
      return;
    }
    setDetecting(true);
    setDetectMsg('Processando…');
    try {
      const res = (await send('ai-detect-and-create-schedules', undefined)) as
        | {
            parceladas: { detected: number; created: number };
            recurring: { detected: number; created: number };
          }
        | { error: string };
      if ('error' in res) {
        setDetectMsg(`Erro: ${res.error}`);
      } else {
        setDetectMsg(
          `Parceladas: ${res.parceladas.created}/${res.parceladas.detected} criadas. Recorrentes: ${res.recurring.created}/${res.recurring.detected} criadas.`,
        );
        void refresh();
      }
    } catch (err) {
      setDetectMsg(`Erro: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setDetecting(false);
    }
  }, [refresh]);

  const cleanupTags = useCallback(async () => {
    if (cleaningTags) return;
    if (
      !window.confirm(
        'Remover tags "#actual-ai" e "#actual-ai-miss" das notas das transações?',
      )
    ) {
      return;
    }
    setCleaningTags(true);
    setCleanupMsg('Processando…');
    try {
      const res = (await send('ai-cleanup-actual-ai-tags', undefined)) as {
        scanned: number;
        cleaned: number;
      };
      setCleanupMsg(`Verificadas ${res.scanned}, limpas ${res.cleaned}.`);
    } catch (err) {
      setCleanupMsg(
        `Erro: ${err instanceof Error ? err.message : String(err)}`,
      );
    } finally {
      setCleaningTags(false);
    }
  }, [cleaningTags]);

  const totalTokens = (entries || []).reduce(
    (acc, e) => {
      if (e.tokens) {
        acc.input += e.tokens.input;
        acc.output += e.tokens.output;
      }
      return acc;
    },
    { input: 0, output: 0 },
  );

  return (
    <>
      {/* Floating button (smaller, above chat) */}
      {!open && (
        <Button
          variant="bare"
          aria-label={t('Abrir log de atividade IA')}
          onPress={() => setOpen(true)}
          style={{
            position: 'fixed',
            bottom: 92,
            right: 28,
            width: 44,
            height: 44,
            borderRadius: '50%',
            padding: 0,
            zIndex: 1099,
            backgroundColor: theme.tableBackground,
            border: `1px solid ${theme.tableBorder}`,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            boxShadow: '0 2px 8px rgba(0,0,0,0.18)',
          }}
        >
          <SvgNotesPaperText width={18} height={18} />
        </Button>
      )}

      {open && (
        <View
          style={{
            position: 'fixed',
            right: 24,
            bottom: 24,
            width: PANEL_WIDTH,
            height: PANEL_HEIGHT,
            maxHeight: 'calc(100vh - 48px)',
            transform: `translate(${pos.x}px, ${pos.y}px)`,
            backgroundColor: theme.pageBackground,
            border: `1px solid ${theme.tableBorder}`,
            borderRadius: 16,
            boxShadow:
              '0 20px 50px -10px rgba(15, 23, 42, 0.30), 0 8px 24px rgba(15, 23, 42, 0.12)',
            zIndex: 1100,
            display: 'flex',
            flexDirection: 'column',
            overflow: 'hidden',
          }}
        >
          {/* Header (drag handle) */}
          <View
            {...handleProps}
            style={{
              ...handleProps.style,
              padding: '12px 16px',
              borderBottom: `1px solid ${theme.tableBorder}`,
              flexDirection: 'row',
              alignItems: 'center',
              gap: 8,
              flexShrink: 0,
              backgroundColor: theme.tableBackground,
            }}
          >
            <SvgNotesPaperText width={18} height={18} />
            <Text style={{ fontWeight: 600, flex: 1 }}>
              <Trans>Atividade IA</Trans>
            </Text>
            <Text style={{ fontSize: 11, color: theme.pageTextSubdued }}>
              {entries
                ? `${entries.length} eventos · ${totalTokens.input.toLocaleString('pt-BR')}+${totalTokens.output.toLocaleString('pt-BR')} tokens`
                : ''}
            </Text>
            <Button
              variant="bare"
              onPress={refresh}
              style={{ fontSize: 12, padding: '4px 8px' }}
            >
              <Trans>Atualizar</Trans>
            </Button>
            <Button
              variant="bare"
              aria-label={t('Fechar')}
              onPress={() => setOpen(false)}
              style={{ fontSize: 18, padding: '0 6px', lineHeight: 1 }}
            >
              ×
            </Button>
          </View>

          {error && (
            <View
              style={{
                margin: 12,
                padding: 10,
                backgroundColor: theme.errorBackground,
                color: theme.errorText,
                borderRadius: 4,
              }}
            >
              <Text style={{ fontSize: 12 }}>
                <Trans>Erro:</Trans> {error}
              </Text>
            </View>
          )}

          {/* Detect schedules action */}
          <View
            style={{
              padding: '8px 12px',
              borderBottom: `1px solid ${theme.tableBorder}`,
              backgroundColor: theme.tableBackground,
              flexShrink: 0,
              gap: 6,
            }}
          >
            <View
              style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}
            >
              <Text style={{ flex: 1, fontSize: 11 }}>
                <Trans>
                  Detectar parceladas e recorrentes (cria schedules)
                </Trans>
              </Text>
              <Button
                variant="bare"
                isDisabled={detecting}
                onPress={onDeleteAllSchedules}
                style={{ fontSize: 11, padding: '4px 8px' }}
              >
                <Trans>Apagar tudo</Trans>
              </Button>
              <Button
                variant="primary"
                isDisabled={detecting}
                onPress={onDetectSchedules}
                style={{ fontSize: 11, padding: '4px 10px' }}
              >
                {detecting ? t('Detectando…') : t('Detectar')}
              </Button>
            </View>
            {detectMsg && (
              <Text
                style={{
                  fontSize: 10,
                  color: detectMsg.startsWith('Erro')
                    ? theme.errorText
                    : theme.pageTextSubdued,
                }}
              >
                {detectMsg}
              </Text>
            )}
          </View>

          {/* Cleanup action */}
          <View
            style={{
              padding: '8px 12px',
              borderBottom: `1px solid ${theme.tableBorder}`,
              backgroundColor: theme.tableBackground,
              flexShrink: 0,
              gap: 6,
            }}
          >
            <View
              style={{
                flexDirection: 'row',
                alignItems: 'center',
                gap: 8,
              }}
            >
              <Text style={{ flex: 1, fontSize: 11 }}>
                <Trans>
                  Limpar tags #actual-ai herdadas do container externo
                </Trans>
              </Text>
              <Button
                variant="bare"
                isDisabled={cleaningTags}
                onPress={cleanupTags}
                style={{ fontSize: 11, padding: '4px 10px' }}
              >
                {cleaningTags ? t('Limpando…') : t('Limpar')}
              </Button>
            </View>
            {cleanupMsg && (
              <Text
                style={{
                  fontSize: 10,
                  color: cleanupMsg.startsWith('Erro')
                    ? theme.errorText
                    : theme.pageTextSubdued,
                }}
              >
                {cleanupMsg}
              </Text>
            )}
          </View>

          {/* Entries split: running vs completed */}
          <View
            style={{
              flex: 1,
              minHeight: 0,
              overflowY: 'auto',
            }}
          >
            {entries?.length === 0 && (
              <View
                style={{
                  padding: 40,
                  alignItems: 'center',
                  color: theme.pageTextSubdued,
                }}
              >
                <Text>
                  <Trans>Nenhuma atividade registrada ainda.</Trans>
                </Text>
              </View>
            )}
            {entries &&
              entries.filter(e => e.status === 'running').length > 0 && (
                <View
                  style={{
                    padding: '6px 14px',
                    backgroundColor: theme.tableBackground,
                    fontSize: 10,
                    fontWeight: 600,
                    textTransform: 'uppercase',
                    color: theme.pageTextSubdued,
                    letterSpacing: 0.4,
                    borderBottom: `1px solid ${theme.tableBorder}`,
                  }}
                >
                  <Trans>Em execução</Trans>
                </View>
              )}
            {entries
              ?.filter(e => e.status === 'running')
              .map(e => (
                <Entry key={e.id || `${e.timestamp}-${e.op}`} e={e} />
              ))}
            {entries && entries.some(e => e.status !== 'running') && (
              <View
                style={{
                  padding: '6px 14px',
                  backgroundColor: theme.tableBackground,
                  fontSize: 10,
                  fontWeight: 600,
                  textTransform: 'uppercase',
                  color: theme.pageTextSubdued,
                  letterSpacing: 0.4,
                  borderBottom: `1px solid ${theme.tableBorder}`,
                  borderTop: entries.some(e => e.status === 'running')
                    ? `1px solid ${theme.tableBorder}`
                    : undefined,
                }}
              >
                <Trans>Concluídos</Trans>
              </View>
            )}
            {entries
              ?.filter(e => e.status !== 'running')
              .map(e => (
                <Entry key={e.id || `${e.timestamp}-${e.op}`} e={e} />
              ))}
          </View>
        </View>
      )}
    </>
  );
}
