import { useEffect } from 'react';
import { Icon } from './icons.js';
import styles from '../styles/dashboard.module.css';

export type NoticeInput =
  { kind: 'done'; habitId: string; text: string } | { kind: 'error'; text: string };
export type Notice = NoticeInput & { stamp: number };
// How long the Undo snackbar stays after a completion; afterwards Undo is in Details.
export const UNDO_WINDOW_MS = 5000;

/**
 * Bottom snackbar: a completion with a short-lived Undo, or an error that stays until
 * dismissed or replaced. Only the latest notice is shown.
 */
export function Snackbar({
  notice,
  dismiss,
  undo,
  undoBusy,
}: {
  notice: Notice | null;
  dismiss: () => void;
  undo?: () => void;
  undoBusy?: boolean;
}) {
  useEffect(() => {
    if (notice?.kind !== 'done') return;
    const timer = setTimeout(dismiss, UNDO_WINDOW_MS);
    return () => clearTimeout(timer);
  }, [notice?.stamp]);
  if (!notice) return null;
  const error = notice.kind === 'error';
  return (
    <div
      className={`${styles.snackbar} ${error ? styles.snackbarError : ''}`}
      role={error ? 'alert' : 'status'}
    >
      <span>{notice.text}</span>
      {!error && undo && (
        <button type="button" onClick={undo} disabled={undoBusy}>
          {undoBusy ? '취소 중…' : '실행 취소'}
        </button>
      )}
      {error && (
        <button
          type="button"
          className={styles.snackbarClose}
          aria-label="알림 닫기"
          onClick={dismiss}
        >
          <Icon name="close" size={18} />
        </button>
      )}
    </div>
  );
}
