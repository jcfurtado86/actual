import React, { useCallback, useEffect, useRef, useState } from 'react';
import type { KeyboardEvent } from 'react';
import { Trans, useTranslation } from 'react-i18next';

import { Button } from '@actual-app/components/button';
import { SvgChatBubbleDots } from '@actual-app/components/icons/v1';
import { Input } from '@actual-app/components/input';
import { Text } from '@actual-app/components/text';
import { theme } from '@actual-app/components/theme';
import { View } from '@actual-app/components/view';
import { send } from '@actual-app/core/platform/client/connection';

import { useDraggable } from '#hooks/useDraggable';

type ChatMessage = {
  role: 'user' | 'assistant';
  content: string;
  timestamp: string;
  model?: string;
  tokens?: { input: number; output: number };
};

type ChatPayload = { messages: ChatMessage[]; latest?: ChatMessage };
type MaybeError<T> = T | { error: string };

function isError<T extends object>(
  r: MaybeError<T> | null,
): r is {
  error: string;
} {
  return r !== null && 'error' in r;
}

function formatTime(iso: string): string {
  try {
    return new Date(iso).toLocaleString('pt-BR', {
      day: '2-digit',
      month: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    });
  } catch {
    return iso;
  }
}

function translateError(code: string, t: (s: string) => string): string {
  switch (code) {
    case 'ai-not-configured':
      return t('GOOGLE_API_KEY não configurada no servidor.');
    case 'no-server-configured':
      return t('Servidor não configurado.');
    case 'not-logged-in':
      return t('Sessão expirada — faça login novamente.');
    case 'no-budget-loaded':
      return t('Nenhum budget aberto.');
    case 'empty-message':
      return t('Mensagem vazia.');
    default:
      return code;
  }
}

const PANEL_WIDTH = 440;
const PANEL_HEIGHT = 620;

export function Chat() {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const { pos, handleProps } = useDraggable();
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const bottomRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const loaded = useRef(false);

  // Load history on first open
  useEffect(() => {
    if (!open || loaded.current) return;
    loaded.current = true;
    void (async () => {
      const res = (await send(
        'ai-chat-list',
        undefined,
      )) as MaybeError<ChatPayload>;
      if (!isError(res)) {
        setMessages(res.messages);
      }
    })();
  }, [open]);

  useEffect(() => {
    if (open) bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages.length, loading, open]);

  useEffect(() => {
    if (open) {
      setTimeout(() => inputRef.current?.focus(), 50);
    }
  }, [open]);

  const sendMessage = useCallback(async () => {
    const text = input.trim();
    if (!text || loading) return;
    setError(null);
    setLoading(true);

    const optimistic: ChatMessage = {
      role: 'user',
      content: text,
      timestamp: new Date().toISOString(),
    };
    setMessages(prev => [...prev, optimistic]);
    setInput('');

    try {
      const res = (await send('ai-chat-send', {
        message: text,
      })) as MaybeError<ChatPayload>;
      if (isError(res)) {
        setError(res.error);
        setMessages(prev => prev.slice(0, -1));
        setInput(text);
        return;
      }
      setMessages(res.messages);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setMessages(prev => prev.slice(0, -1));
      setInput(text);
    } finally {
      setLoading(false);
    }
  }, [input, loading]);

  const clearChat = useCallback(async () => {
    if (loading) return;
    if (
      !window.confirm(t('Limpar toda a conversa? Esta ação é irreversível.'))
    ) {
      return;
    }
    const res = (await send(
      'ai-chat-clear',
      undefined,
    )) as MaybeError<ChatPayload>;
    if (!isError(res)) {
      setMessages(res.messages);
    }
  }, [loading, t]);

  const onKeyDown = useCallback(
    (e: KeyboardEvent<HTMLInputElement>) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        void sendMessage();
      } else if (e.key === 'Escape') {
        setOpen(false);
      }
    },
    [sendMessage],
  );

  const lastAssistant = [...messages]
    .reverse()
    .find(m => m.role === 'assistant');

  return (
    <>
      {/* Floating button */}
      {!open && (
        <Button
          variant="primary"
          aria-label={t('Abrir chat IA')}
          onPress={() => setOpen(true)}
          style={{
            position: 'fixed',
            bottom: 24,
            right: 24,
            width: 56,
            height: 56,
            borderRadius: '50%',
            padding: 0,
            zIndex: 1100,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            boxShadow: '0 4px 14px rgba(0,0,0,0.25)',
          }}
        >
          <SvgChatBubbleDots width={22} height={22} />
        </Button>
      )}

      {/* Floating window */}
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
            <SvgChatBubbleDots width={18} height={18} />
            <Text style={{ fontWeight: 600, flex: 1 }}>
              <Trans>Chat IA</Trans>
            </Text>
            {lastAssistant?.tokens ? (
              <Text style={{ fontSize: 10, color: theme.pageTextSubdued }}>
                {lastAssistant.tokens.input}+{lastAssistant.tokens.output}
              </Text>
            ) : null}
            <Button
              variant="bare"
              isDisabled={loading || messages.length === 0}
              onPress={clearChat}
              style={{ fontSize: 12, padding: '4px 8px' }}
            >
              <Trans>Limpar</Trans>
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
                flexShrink: 0,
              }}
            >
              <Text style={{ fontSize: 12 }}>{translateError(error, t)}</Text>
            </View>
          )}

          {/* Messages */}
          <View
            style={{
              flex: 1,
              minHeight: 0,
              overflowY: 'auto',
              padding: 12,
              gap: 10,
            }}
          >
            {messages.length === 0 && !loading && (
              <View
                style={{
                  padding: 20,
                  color: theme.pageTextSubdued,
                  fontSize: 13,
                  lineHeight: 1.5,
                }}
              >
                <Text>
                  <Trans>A IA tem acesso aos últimos 90 dias. Tente:</Trans>
                </Text>
                <Text
                  style={{
                    marginTop: 8,
                    display: 'block',
                    fontStyle: 'italic',
                  }}
                >
                  &quot;Onde gastei mais este mês?&quot;
                  <br />
                  &quot;Que assinaturas posso cortar?&quot;
                  <br />
                  &quot;Compare delivery dos últimos 3 meses&quot;
                </Text>
              </View>
            )}

            {messages.map((m, i) => (
              <View
                key={i}
                style={{
                  alignSelf: m.role === 'user' ? 'flex-end' : 'flex-start',
                  maxWidth: '86%',
                  backgroundColor:
                    m.role === 'user'
                      ? theme.tableRowBackgroundHighlight
                      : theme.tableBackground,
                  border: `1px solid ${theme.tableBorder}`,
                  borderRadius: 8,
                  padding: '8px 12px',
                  gap: 3,
                }}
              >
                <Text
                  style={{
                    fontSize: 9,
                    color: theme.pageTextSubdued,
                    textTransform: 'uppercase',
                    letterSpacing: 0.4,
                  }}
                >
                  {m.role === 'user' ? t('Você') : t('Gemini')} ·{' '}
                  {formatTime(m.timestamp)}
                </Text>
                {m.role === 'assistant' ? (
                  <div
                    // oxlint-disable-next-line actual/no-untranslated-strings
                    className="actual-ai-chat-bubble"
                    style={{
                      fontSize: 13,
                      lineHeight: 1.5,
                      color: theme.pageText,
                    }}
                    dangerouslySetInnerHTML={{ __html: m.content }}
                  />
                ) : (
                  <Text style={{ fontSize: 13, whiteSpace: 'pre-wrap' }}>
                    {m.content}
                  </Text>
                )}
              </View>
            ))}

            {loading && (
              <View
                style={{
                  alignSelf: 'flex-start',
                  color: theme.pageTextSubdued,
                  fontSize: 12,
                  fontStyle: 'italic',
                  paddingLeft: 4,
                }}
              >
                <Trans>Gemini pensando…</Trans>
              </View>
            )}
            <div ref={bottomRef} />
          </View>

          {/* Input */}
          <View
            style={{
              flexDirection: 'row',
              gap: 6,
              padding: 12,
              borderTop: `1px solid ${theme.tableBorder}`,
              flexShrink: 0,
            }}
          >
            <Input
              ref={inputRef}
              value={input}
              onChange={e => setInput(e.target.value)}
              onKeyDown={onKeyDown}
              placeholder={t('Pergunte algo…')}
              disabled={loading}
              style={{ flex: 1, fontSize: 13 }}
            />
            <Button
              variant="primary"
              isDisabled={loading || !input.trim()}
              onPress={sendMessage}
              style={{ fontSize: 13, padding: '6px 12px' }}
            >
              <Trans>Enviar</Trans>
            </Button>
          </View>
        </View>
      )}
    </>
  );
}
