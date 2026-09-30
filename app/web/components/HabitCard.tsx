import type { Cell } from '../lib/dashboard-data.js';
import { Icon } from './icons.js';
import styles from '../styles/dashboard.module.css';

export function Strip({ cells, label }: { cells: Cell[]; label: string }) {
  const done = cells.filter((c) => c === 'done').length;
  return (
    <span
      className={styles.strip}
      role="img"
      aria-label={`${label}: ${cells.length}일 중 ${done}일 완료`}
    >
      {cells.map((c, i) => (
        <span key={i} className={styles[`cell_${c}`]} />
      ))}
    </span>
  );
}

/**
 * One Habit on the dashboard. The whole card is its primary action: complete an open
 * Habit, or open Details of a completed one. `onMore` adds the secondary ··· action that
 * opens Details without completing.
 */
export function HabitCard({
  name,
  context,
  streak,
  cells,
  state,
  onPrimary,
  primaryLabel,
  onMore,
  error,
}: {
  name: string;
  context: string;
  streak: string | null;
  cells: Cell[];
  state: 'open' | 'saving' | 'done' | 'off';
  onPrimary?: () => void;
  primaryLabel?: string;
  onMore?: () => void;
  error?: React.ReactNode;
}) {
  return (
    <article className={`${styles.card} ${styles[`card_${state}`]}`}>
      <div className={styles.cardTop}>
        <span className={styles.status} aria-hidden="true">
          {state === 'done' && <Icon name="check" size={13} strokeWidth={3} />}
        </span>
        <span className={styles.context} aria-live="polite">
          {state === 'saving' ? '저장 중…' : context}
        </span>
        {onMore && (
          <button
            type="button"
            className={styles.more}
            aria-label={`${name} 세부 기록`}
            onClick={onMore}
          >
            <Icon name="more" size={18} />
          </button>
        )}
      </div>
      <h3 className={styles.name}>{name}</h3>
      {state === 'done' && <span className={styles.srOnly}>완료됨</span>}
      <span className={styles.streak}>
        연속 <strong>{streak ?? '—'}</strong>
      </span>
      <Strip cells={cells} label="최근 14일" />
      {onPrimary && (
        <button
          type="button"
          className={styles.primary}
          aria-label={primaryLabel}
          aria-pressed={state === 'open' || state === 'saving' ? false : undefined}
          disabled={state === 'saving'}
          onClick={onPrimary}
        />
      )}
      {error}
    </article>
  );
}
