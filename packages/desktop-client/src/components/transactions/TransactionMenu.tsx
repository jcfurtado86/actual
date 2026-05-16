import React, { useMemo } from 'react';
import type { ComponentPropsWithoutRef } from 'react';
import { useTranslation } from 'react-i18next';

import { Menu } from '@actual-app/components/menu';
import { send, sendCatch } from '@actual-app/core/platform/client/connection';
import { q } from '@actual-app/core/shared/query';
import {
  extractScheduleConds,
  scheduleIsRecurring,
} from '@actual-app/core/shared/schedules';
import { isPreviewId } from '@actual-app/core/shared/transactions';
import type { TransactionEntity } from '@actual-app/core/types/models';

import { useCachedSchedules } from '#hooks/useCachedSchedules';
import { useSchedules } from '#hooks/useSchedules';
import { useSelectedItems } from '#hooks/useSelected';
import { pushModal } from '#modals/modalsSlice';
import { addNotification } from '#notifications/notificationsSlice';
import { useDispatch } from '#redux';

type BalanceMenuProps = Omit<
  ComponentPropsWithoutRef<typeof Menu>,
  'onMenuSelect' | 'items'
> & {
  transaction: TransactionEntity;
  getTransaction: (id: string) => TransactionEntity | undefined;
  onDuplicate: (ids: string[]) => void;
  onDelete: (ids: string[]) => void;
  onLinkSchedule: (ids: string[]) => void;
  onUnlinkSchedule: (ids: string[]) => void;
  onCreateRule: (ids: string[]) => void;
  onScheduleAction: (
    name: 'skip' | 'post-transaction' | 'post-transaction-today' | 'complete',
    ids: TransactionEntity['id'][],
  ) => void;
  onMakeAsNonSplitTransactions: (ids: string[]) => void;
  onRefresh?: () => void;
  closeMenu: () => void;
};

export function TransactionMenu({
  transaction,
  getTransaction,
  onDuplicate,
  onDelete,
  onLinkSchedule,
  onUnlinkSchedule,
  onCreateRule,
  onScheduleAction,
  onMakeAsNonSplitTransactions,
  onRefresh,
  closeMenu,
  ...props
}: BalanceMenuProps) {
  const { t } = useTranslation();
  const dispatch = useDispatch();
  const selectedItems = useSelectedItems();

  const selectedIds = useMemo(() => {
    const ids =
      selectedItems && selectedItems.size > 0
        ? selectedItems
        : [transaction.id];
    return Array.from(new Set(ids));
  }, [transaction, selectedItems]);

  const scheduleIds = useMemo(() => {
    return selectedIds
      .filter(id => isPreviewId(id))
      .map(id => id.split('/')[1]);
  }, [selectedIds]);

  const scheduleQuery = useMemo(() => {
    return q('schedules')
      .filter({ id: { $oneof: scheduleIds } })
      .select('*');
  }, [scheduleIds]);

  const { schedules: selectedSchedules } = useSchedules({
    query: scheduleQuery,
  });

  const types = useMemo(() => {
    const items = selectedIds;
    return {
      preview: !!items.find(id => isPreviewId(id)),
      trans: !!items.find(id => !isPreviewId(id)),
    };
  }, [selectedIds]);

  const ambiguousDuplication = useMemo(() => {
    const transactions = selectedIds.map(id => getTransaction(id));

    return transactions.some(tx => tx && tx.is_child);
  }, [selectedIds, getTransaction]);

  const linked = useMemo(() => {
    return (
      !types.preview &&
      selectedIds.every(id => {
        const t = getTransaction(id);
        return t && t.schedule;
      })
    );
  }, [types.preview, selectedIds, getTransaction]);

  const { schedules: allSchedules = [] } = useCachedSchedules();
  const linkedToRecurring = useMemo(() => {
    if (!linked) return false;
    return selectedIds.every(id => {
      const t = getTransaction(id);
      if (!t || !t.schedule) return false;
      const s = allSchedules.find(x => x.id === t.schedule);
      const cfg = s?._date as { endMode?: string } | undefined;
      return (
        !!s &&
        cfg?.endMode !== 'after_n_occurrences' &&
        cfg?.endMode !== 'on_date'
      );
    });
  }, [linked, selectedIds, getTransaction, allSchedules]);

  const canBeSkipped = useMemo(() => {
    const recurringSchedules = selectedSchedules.filter(s => {
      const { date: dateCond } = extractScheduleConds(s._conditions);
      return scheduleIsRecurring(dateCond);
    });

    return recurringSchedules.length === selectedSchedules.length;
  }, [selectedSchedules]);

  const canBeCompleted = useMemo(() => {
    const singleSchedules = selectedSchedules.filter(s => {
      const { date: dateCond } = extractScheduleConds(s._conditions);
      return !scheduleIsRecurring(dateCond);
    });

    return singleSchedules.length === selectedSchedules.length;
  }, [selectedSchedules]);

  const canUnsplitTransactions = useMemo(() => {
    if (selectedIds.length === 0 || types.preview) {
      return false;
    }

    const transactions = selectedIds.map(id => getTransaction(id));

    const areNoReconciledTransactions = transactions.every(
      tx => tx && !tx.reconciled,
    );
    const areAllSplitTransactions = transactions.every(
      tx => tx && (tx.is_parent || tx.is_child),
    );
    return areNoReconciledTransactions && areAllSplitTransactions;
  }, [selectedIds, types, getTransaction]);

  function onViewSchedule() {
    const firstId = selectedIds[0];
    let scheduleId;
    if (isPreviewId(firstId)) {
      const parts = firstId.split('/');
      scheduleId = parts[1];
    } else {
      const trans = getTransaction(firstId);
      scheduleId = trans && trans.schedule;
    }

    if (scheduleId) {
      dispatch(
        pushModal({
          modal: { name: 'schedule-edit', options: { id: scheduleId } },
        }),
      );
    }
  }

  return (
    <Menu
      {...props}
      onMenuSelect={name => {
        switch (name) {
          case 'duplicate':
            onDuplicate(selectedIds);
            break;
          case 'delete':
            onDelete(selectedIds);
            break;
          case 'unsplit-transactions':
            onMakeAsNonSplitTransactions(selectedIds);
            break;
          case 'post-transaction':
          case 'post-transaction-today':
          case 'skip':
          case 'complete':
            onScheduleAction(name, selectedIds);
            break;
          case 'view-schedule':
            onViewSchedule();
            break;
          case 'link-schedule':
            onLinkSchedule(selectedIds);
            break;
          case 'unlink-schedule':
            onUnlinkSchedule(selectedIds);
            break;
          case 'create-rule':
            onCreateRule(selectedIds);
            break;
          case 'remove-recurring':
            void (async () => {
              const ids = selectedIds;
              const scheduleIdsToDelete = Array.from(
                new Set(
                  ids
                    .map(id => getTransaction(id)?.schedule)
                    .filter((s): s is string => !!s),
                ),
              );
              if (scheduleIdsToDelete.length === 0) return;
              await send('transactions-batch-update', {
                updated: ids.map(id => ({ id, schedule: null })),
              });
              for (const sid of scheduleIdsToDelete) {
                const r = await sendCatch('schedule/delete', { id: sid });
                if (r.error) {
                  dispatch(
                    addNotification({
                      notification: {
                        type: 'error',
                        message: t(
                          'Não foi possível remover o agendamento recorrente.',
                        ),
                      },
                    }),
                  );
                  return;
                }
              }
              onRefresh?.();
              dispatch(
                addNotification({
                  notification: {
                    type: 'message',
                    message: t('Recorrência removida.'),
                  },
                }),
              );
            })();
            break;
          case 'make-recurring':
            void (async () => {
              const dateConfig = {
                start: transaction.date,
                frequency: 'monthly' as const,
                patterns: [] as unknown[],
                skipWeekend: false,
                weekendSolveMode: 'after' as const,
                endMode: 'never' as const,
                endOccurrences: 1,
                endDate: transaction.date,
              };
              const conditions = [
                transaction.payee && {
                  op: 'is' as const,
                  field: 'payee',
                  value: transaction.payee,
                },
                transaction.account && {
                  op: 'is' as const,
                  field: 'account',
                  value: transaction.account,
                },
                {
                  op: 'isapprox' as const,
                  field: 'date',
                  value: dateConfig,
                },
                {
                  op: 'isapprox' as const,
                  field: 'amount',
                  value: transaction.amount,
                },
              ].filter(Boolean);
              const name = (transaction.notes || '').trim() || null;
              const res = await sendCatch('schedule/create', {
                conditions,
                schedule: { posts_transaction: false, name },
              });
              if (res.error) {
                dispatch(
                  addNotification({
                    notification: {
                      type: 'error',
                      message: t(
                        'Não foi possível criar o agendamento recorrente.',
                      ),
                    },
                  }),
                );
                return;
              }
              await send('transactions-batch-update', {
                updated: [{ id: transaction.id, schedule: res.data }],
              });
              // Two-stage refresh: the schedules cache (live-queried) needs a
              // beat to pick up the brand-new schedule. Without the second
              // tick the row re-renders before the cache has it and the
              // recurring chip stays hidden until a full page reload.
              onRefresh?.();
              setTimeout(() => onRefresh?.(), 350);
              dispatch(
                addNotification({
                  notification: {
                    type: 'message',
                    message: name
                      ? t('"{{name}}" tornado recorrente (mensal).', { name })
                      : t('Transação tornada recorrente (mensal).'),
                  },
                }),
              );
            })();
            break;
          default:
            throw new Error(`Unrecognized menu option: ${name}`);
        }
        closeMenu();
      }}
      items={[
        ...(!types.trans
          ? [
              ...(selectedIds.length === 1
                ? [{ name: 'view-schedule', text: t('View schedule') }]
                : []),
              { name: 'post-transaction', text: t('Post transaction') },
              {
                name: 'post-transaction-today',
                text: t('Post transaction today'),
              },
              ...(canBeSkipped
                ? [{ name: 'skip', text: t('Skip next scheduled date') }]
                : []),
              ...(canBeCompleted
                ? [{ name: 'complete', text: t('Mark as completed') }]
                : []),
            ]
          : [
              ...(ambiguousDuplication
                ? []
                : [{ name: 'duplicate', text: t('Duplicate') }]),
              { name: 'delete', text: t('Delete') },
              ...(linked
                ? [
                    ...(selectedIds.length === 1
                      ? [{ name: 'view-schedule', text: t('View schedule') }]
                      : []),
                    ...(linkedToRecurring
                      ? [
                          {
                            name: 'remove-recurring',
                            text: t('Remover recorrência'),
                          },
                        ]
                      : []),
                    { name: 'unlink-schedule', text: t('Unlink schedule') },
                  ]
                : [
                    ...(selectedIds.length === 1
                      ? [
                          {
                            name: 'make-recurring',
                            text: t('Tornar recorrente'),
                          },
                        ]
                      : []),
                    {
                      name: 'link-schedule',
                      text: t('Link schedule'),
                    },
                    {
                      name: 'create-rule',
                      text: t('Create rule'),
                    },
                  ]),
              ...(canUnsplitTransactions
                ? [
                    {
                      name: 'unsplit-transactions',
                      text: t('Unsplit {{count}} transactions', {
                        count: selectedIds.length,
                      }),
                    },
                  ]
                : []),
            ]),
      ]}
    />
  );
}
