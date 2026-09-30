import { useSyncExternalStore } from 'react';
import { addDays, bounds } from '../../shared/domain/index.js';
import { useData, type Stats, type Today } from '../lib/api-client.js';
import type { useDashboardData } from '../lib/dashboard-data.js';
import { percentText, shortDate } from '../lib/format.js';
import styles from '../styles/dashboard.module.css';

const WIDE = '(min-width: 1100px)';
const subscribe = (change: () => void) => {
  const query = window.matchMedia(WIDE);
  query.addEventListener('change', change);
  return () => query.removeEventListener('change', change);
};
/** True while the viewport is wide enough for the desktop analysis rail. */
export const useWide = () =>
  useSyncExternalStore(
    subscribe,
    () => window.matchMedia(WIDE).matches,
    () => false,
  );

const WEEKS = 12;
const heatStep = (rate: number) => Math.min(4, Math.floor(rate / 20));

/**
 * The desktop dashboard's right column: the last 12 weeks of scheduled completion,
 * today's Routine progress and the quota periods still running. Only rendered on wide
 * screens, so the 12-week request is never made on a phone.
 */
export function InsightRail({
  today,
  data,
}: {
  today: Today;
  data: ReturnType<typeof useDashboardData>;
}) {
  const start = addDays(bounds(today.date, 'weeks').start, -7 * (WEEKS - 1));
  const heat = useData<Stats>(
    `/statistics?${new URLSearchParams({ from: start, to: today.date })}`,
  );
  const values = new Map(heat.data?.data.heatmap.map((d) => [d.date, d]));
  const days = Array.from({ length: WEEKS * 7 }, (_, i) => addDays(start, i));
  const name = (id: string) => data.habits.find((h) => h.id === id)?.name ?? '';
  return (
    <aside className={styles.rail} aria-label="분석 요약">
      <section className={styles.panel}>
        <div className={styles.panelTitle}>
          <h2>최근 12주</h2>
          <span>{heat.data ? percentText(heat.data.data.date_scheduled.rate) : '…'}</span>
        </div>
        <div className={styles.heatmap}>
          {days.map((day) => {
            const v = values.get(day);
            const step = day > today.date || v?.rate == null ? null : heatStep(v.rate);
            const label = v
              ? `${shortDate(day)}: ${v.total}개 중 ${v.completed}개`
              : `${shortDate(day)}: 예정 없음`;
            return (
              <span
                key={day}
                title={label}
                className={day > today.date ? styles.heatFuture : undefined}
                style={step === null ? undefined : { background: `var(--heat-${step})` }}
              />
            );
          })}
        </div>
        <p className={styles.srOnly}>
          최근 12주 예정 습관 완료율{' '}
          {heat.data ? percentText(heat.data.data.date_scheduled.rate) : ''}
        </p>
        <div className={styles.legend} aria-hidden="true">
          적음
          {[0, 1, 2, 3, 4].map((s) => (
            <span key={s} style={{ background: `var(--heat-${s})` }} />
          ))}
          많음
        </div>
      </section>
      {today.routines.length > 0 && (
        <section className={styles.panel}>
          <div className={styles.panelTitle}>
            <h2>루틴 진행</h2>
            <span>오늘</span>
          </div>
          {today.routines.map((r) => {
            const its = today.items.filter(
              (i) => !i.quota && i.routine_contexts.some((c) => c.routine_id === r.id),
            );
            const done = its.filter((i) => i.execution?.status === 'completed').length;
            return (
              <div key={r.id} className={styles.progressRow}>
                <div>
                  <h3>{r.name}</h3>
                  <strong>
                    {done}/{its.length}
                  </strong>
                </div>
                <span className={styles.bar} aria-hidden="true">
                  <span style={{ width: `${its.length ? (done / its.length) * 100 : 0}%` }} />
                </span>
              </div>
            );
          })}
        </section>
      )}
      <section className={styles.panel}>
        <div className={styles.panelTitle}>
          <h2>진행 중인 목표</h2>
        </div>
        {!data.liveQuotas.length && <p className={styles.muted}>진행 중인 목표 기간이 없어요.</p>}
        {data.liveQuotas.map((q) => (
          <div key={q.id} className={styles.progressRow}>
            <div>
              <h3>{name(q.habit_id)}</h3>
              <strong>
                {q.actual_count}/{q.target_count}
              </strong>
            </div>
            <span className={styles.bar} aria-hidden="true">
              <span
                style={{ width: `${Math.min(100, (q.credited_count / q.target_count) * 100)}%` }}
              />
            </span>
            <small>
              {q.unit === 'weeks' ? '이번 주' : '이번 달'} · {shortDate(q.end)}까지
            </small>
          </div>
        ))}
      </section>
    </aside>
  );
}
