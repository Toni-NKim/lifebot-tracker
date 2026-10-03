import { useEffect, useRef, useState } from 'react';
import { addDays } from '../../shared/domain/index.js';
import { useData, type Stats } from '../lib/api-client.js';
import { useExecution, type Item } from '../lib/use-execution.js';
import { useDetailsOpen } from '../lib/execution-store.js';
import { Strip } from './HabitCard.js';
import { Icon } from './icons.js';
import { ErrorBox } from './common.js';
import type { Cell } from '../lib/dashboard-data.js';
import { amountText, clockTime, minutesText, percentText, streakText } from '../lib/format.js';
import styles from '../styles/details.module.css';

type HabitStats = Stats['habits'][number];
const QUALITY = ['쉬움', '보통', '힘듦'];

/**
 * Details of one Habit: optional context before or after completion, Undo, and the
 * Habit's heavier statistics, which load only when that section is opened. Without a
 * today item (a Habit not due today) only the statistics are shown.
 */
export function DetailsSheet({
  habitId,
  name,
  subtitle,
  item,
  date,
  timezone,
  etag,
  cells,
  streak,
  amounts,
  close,
}: {
  habitId: string;
  name: string;
  subtitle: string;
  item?: Item;
  date: string;
  timezone: string;
  etag: string;
  cells: Cell[];
  streak: HabitStats | null;
  amounts: (string | null)[];
  close: () => void;
}) {
  const panel = useRef<HTMLDialogElement>(null);
  // A modal dialog: the dashboard behind it is inert (no focus, no pointer, hidden from
  // assistive technology) until it closes. Focus then returns to whatever opened it, or to
  // the Habit's card when that control is gone (the ··· button after completing here).
  useEffect(() => {
    const dialog = panel.current!;
    const opener = document.activeElement as HTMLElement | null;
    dialog.showModal();
    dialog.focus({ preventScroll: true });
    return () => {
      if (dialog.open) dialog.close();
      const target = opener?.isConnected
        ? opener
        : document.querySelector<HTMLElement>(
            `[data-habit="${CSS.escape(habitId)}"] [data-primary]`,
          );
      target?.focus({ preventScroll: true });
    };
  }, []);
  return (
    <dialog
      ref={panel}
      tabIndex={-1}
      className={styles.sheet}
      aria-label={`${name} 세부 기록`}
      data-details-sheet=""
      // Escape: React decides when the sheet closes.
      onCancel={(e) => {
        e.preventDefault();
        close();
      }}
      // A click on the backdrop lands on the dialog itself, outside its box.
      onClick={(e) => {
        if (e.target !== e.currentTarget) return;
        const r = e.currentTarget.getBoundingClientRect();
        const inside =
          e.clientX >= r.left &&
          e.clientX <= r.right &&
          e.clientY >= r.top &&
          e.clientY <= r.bottom;
        if (!inside) close();
      }}
      onKeyDown={(e) => {
        if (e.key === 'Tab') wrapFocus(e);
      }}
    >
      <span className={styles.grabber} aria-hidden="true" />
      <header className={styles.header}>
        <div>
          <h2>{name}</h2>
          <p>{subtitle}</p>
        </div>
        <button
          type="button"
          className={styles.iconButton}
          aria-label="세부 기록 닫기"
          onClick={close}
        >
          <Icon name="close" />
        </button>
      </header>
      {item ? (
        <ExecutionForm
          stats={
            <HabitStatistics
              habitId={habitId}
              date={date}
              cells={cells}
              streak={streak}
              amounts={amounts}
              unit={item.habit.unit}
              open={false}
            />
          }
          item={item}
          date={date}
          timezone={timezone}
          etag={etag}
          close={close}
        />
      ) : (
        <>
          <p className={styles.hint}>오늘은 예정이 없어요. 최근 기록만 볼 수 있어요.</p>
          <HabitStatistics
            habitId={habitId}
            date={date}
            cells={cells}
            streak={streak}
            amounts={amounts}
            unit={null}
            open
          />
        </>
      )}
    </dialog>
  );
}

// Traverse every visible control explicitly. WebKit's native Tab order can skip
// buttons/summary controls, so waiting for the DOM's last control can miss the
// boundary and send focus to browser chrome instead of wrapping within the modal.
function wrapFocus(e: React.KeyboardEvent<HTMLDialogElement>) {
  const controls = [
    ...e.currentTarget.querySelectorAll<HTMLElement>(
      'button, input, textarea, select, summary, a[href], [tabindex]:not([tabindex="-1"])',
    ),
  ].filter((el) => !(el as HTMLButtonElement).disabled && el.offsetParent !== null);
  if (!controls.length) return;
  const index = controls.indexOf(document.activeElement as HTMLElement);
  const next =
    index < 0
      ? e.shiftKey
        ? controls.length - 1
        : 0
      : (index + (e.shiftKey ? -1 : 1) + controls.length) % controls.length;
  e.preventDefault();
  controls[next].focus();
}

function ExecutionForm({
  item,
  date,
  timezone,
  etag,
  close,
  stats,
}: {
  stats: React.ReactNode;
  item: Item;
  date: string;
  timezone: string;
  etag: string;
  close: () => void;
}) {
  const x = useExecution(item, date, etag);
  // While this sheet is open, failed writes of this Habit are shown here, not in the snackbar.
  useDetailsOpen(`${date}/${item.habit_id}`);
  const form = useRef<HTMLFormElement>(null);
  const h = item.habit;
  const e = item.execution;
  const busy = x.busy;
  const valid = () => form.current?.reportValidity() ?? true;
  const minimum = h.minimum_duration_seconds;
  return (
    <>
      {x.complete && e?.completed_at ? (
        <div className={styles.completed}>
          <span className={styles.check} aria-hidden="true">
            <Icon name="check" size={16} strokeWidth={3} />
          </span>
          <span>
            <strong>{clockTime(e.completed_at, timezone)}에 완료</strong>
            <small>세부 기록을 나중에 고쳐도 완료 시각은 그대로예요</small>
          </span>
        </div>
      ) : (
        <p className={styles.hint}>
          {h.description ? `${h.description} · ` : ''}
          세부 기록은 선택이에요. “완료”를 누를 때 함께 저장되고, 그 전까지는 이 기기에만 있어요.
        </p>
      )}
      {x.complete && h.description && <p className={styles.hint}>{h.description}</p>}
      {stats}
      <ErrorBox error={x.error} />
      <form
        ref={form}
        className={styles.form}
        onSubmit={(ev) => ev.preventDefault()}
        noValidate={false}
      >
        <div className={styles.row}>
          <label>
            실제 수행량{h.unit ? ` (${h.unit})` : ''}
            <input
              disabled={busy}
              inputMode="decimal"
              pattern="(?:0|[1-9][0-9]*)(?:\.[0-9]+)?"
              placeholder={h.target_amount !== null ? `목표 ${h.target_amount}` : undefined}
              value={x.details.actual_amount ?? ''}
              onChange={(ev) => x.edit({ actual_amount: ev.target.value || null })}
            />
          </label>
          <label>
            수행 시간 (분)
            <input
              disabled={busy}
              type="number"
              min="0"
              step="0.1"
              placeholder={minimum !== null ? `최소 ${minimum / 60}` : undefined}
              value={x.details.duration_seconds === null ? '' : x.details.duration_seconds / 60}
              onChange={(ev) =>
                x.edit({
                  duration_seconds:
                    ev.target.value === '' ? null : Math.round(Number(ev.target.value) * 60),
                })
              }
            />
          </label>
        </div>
        {(h.target_amount !== null || minimum !== null) && (
          <div className={styles.chips}>
            {h.target_amount !== null && (
              <button
                type="button"
                disabled={busy}
                onClick={() => x.edit({ actual_amount: h.target_amount })}
              >
                목표 {amountText(h.target_amount, h.unit)} 입력
              </button>
            )}
            {minimum !== null && (
              <button
                type="button"
                disabled={busy}
                onClick={() => x.edit({ duration_seconds: minimum })}
              >
                최소 {minutesText(minimum)} 입력
              </button>
            )}
          </div>
        )}
        <label>
          난이도 또는 완성도
          <textarea
            rows={2}
            disabled={busy}
            value={x.details.difficulty_or_quality ?? ''}
            onChange={(ev) => x.edit({ difficulty_or_quality: ev.target.value || null })}
          />
        </label>
        <div className={styles.chips} role="group" aria-label="빠른 입력: 난이도">
          {QUALITY.map((q) => (
            <button
              key={q}
              type="button"
              disabled={busy}
              aria-pressed={x.details.difficulty_or_quality === q}
              onClick={() => x.edit({ difficulty_or_quality: q })}
            >
              {q}
            </button>
          ))}
        </div>
        <label>
          에너지 메모
          <textarea
            disabled={busy}
            value={x.details.energy_note ?? ''}
            onChange={(ev) => x.edit({ energy_note: ev.target.value || null })}
          />
        </label>
      </form>
      <footer className={styles.footer}>
        {x.complete ? (
          <>
            <button
              type="button"
              className={styles.primary}
              disabled={busy || !x.draft}
              onClick={() => valid() && x.saveDetails()}
            >
              {busy ? '저장 중…' : '세부 기록 저장'}
            </button>
            <div className={styles.footRow}>
              <span className={styles.lock}>
                <Icon name="lock" size={13} />
                오늘까지만 수정할 수 있어요
              </span>
              <button
                type="button"
                className={styles.undo}
                disabled={busy}
                onClick={() => x.undo()}
              >
                완료 취소
              </button>
            </div>
          </>
        ) : (
          <div className={styles.footRow}>
            <button
              type="button"
              className={styles.primary}
              disabled={busy}
              onClick={() => valid() && x.completeNow({ onSuccess: close })}
            >
              {busy ? '저장 중…' : '완료'}
            </button>
            <button
              type="button"
              className={styles.secondary}
              disabled={busy}
              onClick={() => {
                x.discard();
                close();
              }}
            >
              취소
            </button>
          </div>
        )}
      </footer>
    </>
  );
}

// The Habit's heavier statistics, requested only when the section is opened.
function HabitStatistics({
  habitId,
  date,
  cells,
  streak,
  amounts,
  unit,
  open: initiallyOpen,
}: {
  habitId: string;
  date: string;
  cells: Cell[];
  streak: HabitStats | null;
  amounts: (string | null)[];
  unit: string | null;
  open: boolean;
}) {
  const [open, setOpen] = useState(initiallyOpen);
  const from = addDays(date, -29);
  const stats = useData<Stats>(
    `/statistics?${new URLSearchParams({ from, to: date, habit_id: habitId })}`,
    open,
  );
  const s = stats.data?.data;
  const own = s?.habits.find((h) => h.id === habitId);
  const quota =
    s && (s.weekly_quota.total ? s.weekly_quota : s.monthly_quota.total ? s.monthly_quota : null);
  const longest = own
    ? Object.entries(own.longest)
        .filter(([, n]) => n > 0)
        .map(([u, n]) => streakText(n, u as keyof typeof own.longest))
        .join(' · ') || '0'
    : '…';
  const numbers = amounts.map((a) => (a === null ? null : Number(a)));
  const max = Math.max(1, ...numbers.map((n) => n ?? 0));
  const recorded = numbers.filter((n): n is number => n !== null);
  return (
    <details
      className={styles.stats}
      open={open}
      onToggle={(ev) => setOpen((ev.target as HTMLDetailsElement).open)}
    >
      <summary>
        이 습관의 통계
        <span>
          {streak ? `연속 ${streakText(streak.current, streak.unit)}` : ''}
          {open ? '' : ' · 펼치면 30일 통계를 불러와요'}
        </span>
      </summary>
      <div className={styles.statsBody}>
        <ErrorBox error={stats.error} />
        <dl className={styles.statGrid}>
          <div>
            <dt>30일 완료율</dt>
            <dd>{s ? percentText((quota ?? s.date_scheduled).rate) : '…'}</dd>
          </div>
          <div>
            <dt>최장 연속</dt>
            <dd>{longest}</dd>
          </div>
          <div>
            <dt>평균 수행량</dt>
            <dd>
              {recorded.length
                ? amountText(
                    String(
                      Math.round((recorded.reduce((a, b) => a + b, 0) / recorded.length) * 10) / 10,
                    ),
                    unit,
                  )
                : '—'}
            </dd>
          </div>
        </dl>
        <Strip cells={cells} label="최근 14일" />
        {recorded.length > 0 && (
          <div
            className={styles.amounts}
            role="img"
            aria-label={`최근 14일 수행량: ${recorded.join(', ')}`}
          >
            {numbers.map((n, i) => (
              <span
                key={i}
                style={{ height: n === null ? 3 : Math.max(6, (n / max) * 44) }}
                className={n === null ? styles.amountEmpty : ''}
              />
            ))}
          </div>
        )}
        {quota && <p className={styles.hint}>주·월 목표는 마감된 기간 기준이에요.</p>}
      </div>
    </details>
  );
}

export const subtitleFor = (item: Item | undefined, schedule: string, time: string | null) =>
  [
    schedule,
    time,
    item?.habit.minimum_duration_seconds != null &&
      `최소 ${minutesText(item.habit.minimum_duration_seconds)}`,
    item?.habit.target_amount != null &&
      `목표 ${amountText(item.habit.target_amount, item.habit.unit)}`,
  ]
    .filter(Boolean)
    .join(' · ');
