import React, { useCallback, useState } from 'react';
import { Trans, useTranslation } from 'react-i18next';

import { Button } from '@actual-app/components/button';
import { Text } from '@actual-app/components/text';
import { View } from '@actual-app/components/view';
import { send } from '@actual-app/core/platform/client/connection';

import { Checkbox } from '#components/forms';
import { useSyncedPref } from '#hooks/useSyncedPref';

import { Setting } from './UI';

export function AiSettings() {
  const { t } = useTranslation();
  const [value, setValue] = useSyncedPref('aiAutoCategorize');
  const enabled = value !== 'false';
  const [detecting, setDetecting] = useState(false);
  const [detectMsg, setDetectMsg] = useState<string | null>(null);

  const onToggle = useCallback(() => {
    setValue(enabled ? 'false' : 'true');
  }, [enabled, setValue]);

  const onDetect = useCallback(async () => {
    if (
      !window.confirm(
        t(
          'Detectar parceladas e cobranças recorrentes e criar Schedules automaticamente?',
        ),
      )
    ) {
      return;
    }
    setDetecting(true);
    setDetectMsg(t('Processando…'));
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
      }
    } catch (err) {
      setDetectMsg(`Erro: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setDetecting(false);
    }
  }, [t]);

  return (
    <>
      <Setting
        primaryAction={
          <View style={{ flexDirection: 'row', gap: 8, alignItems: 'center' }}>
            <Checkbox
              id="ai-auto-categorize"
              checked={enabled}
              onChange={onToggle}
            />
            <label htmlFor="ai-auto-categorize">
              <Trans>Auto-categorizar transações novas após sync</Trans>
            </label>
          </View>
        }
      >
        <Text>
          <Trans>
            <strong>Assistente de IA</strong>: quando ligado, transações
            importadas pelo bank sync (Pluggy) são automaticamente categorizadas
            pelo Gemini, usando as categorias do orçamento como referência.
            Categorizações pouco confiáveis são deixadas em branco. Você pode
            revisar manualmente a qualquer momento.
          </Trans>
        </Text>
      </Setting>

      <Setting
        primaryAction={
          <View style={{ flexDirection: 'column', gap: 6 }}>
            <Button variant="primary" isDisabled={detecting} onPress={onDetect}>
              {detecting
                ? t('Detectando…')
                : t('Detectar parceladas e recorrentes')}
            </Button>
            {detectMsg && <Text style={{ fontSize: 11 }}>{detectMsg}</Text>}
          </View>
        }
      >
        <Text>
          <Trans>
            <strong>Previsão de futuro</strong>: detecta compras parceladas
            (PARC X/Y) no histórico via regex e cria um Schedule para cada
            parcela restante. Também pede pro Gemini identificar cobranças
            mensais recorrentes (Spotify, Netflix, contas) e cria Schedules sem
            fim pra elas. Quando o banco efetivar a cobrança no sync, o Actual
            liga automaticamente a transação ao Schedule.
          </Trans>
        </Text>
      </Setting>
    </>
  );
}
