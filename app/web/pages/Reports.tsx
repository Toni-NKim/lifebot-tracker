import { useState } from 'react';
import {
  useData,
  useRaw,
  useWrite,
  type Stats,
  type HistoryData,
  type Today,
} from '../lib/api-client.js';
import { Heading, ErrorBox, Empty, percent } from '../components/common.js';
import { Icon } from '../components/icons.js';
import { STREAK_UNIT, clockTime, longDate, shortDate } from '../lib/format.js';
import { bounds, date, addDays } from '../../shared/domain/index.js';
import styles from '../styles/reports.module.css';
type Period = 'day' | 'week' | 'month' | 'all';
const PERIODS: [Period, string][] = [
  ['day', '일'],
  ['week', '주'],
  ['month', '월'],
  ['all', '전체'],
];
const HEAT = ['var(--heat-0)', 'var(--heat-1)', 'var(--heat-2)', 'var(--heat-3)', 'var(--heat-4)'];
const heatStep = (rate: number) => Math.min(4, Math.floor(rate / 20));
function Notice({ children, role }: { children: React.ReactNode; role?: 'status' }) {
  return (
    <p className={styles.notice} role={role}>
      {children}
    </p>
  );
}
export function QuotaBar({ value, max }: { value: number; max: number }) {
  return (
    <span className={styles.bar} aria-hidden="true">
      <span style={{ width: `${max ? Math.min(100, (value / max) * 100) : 0}%` }} />
    </span>
  );
}
function shiftDay(day: string, period: Period, direction: 1 | -1) {
  if (period === 'day') return addDays(day, direction);
  if (period === 'week') return addDays(day, 7 * direction);
  const b = bounds(day, 'months');
  return direction < 0 ? bounds(addDays(b.start, -1), 'months').start : addDays(b.end, 1);
}
function periodTitle(day: string, period: Period) {
  if (period === 'day') return longDate(day);
  if (period === 'week') {
    const b = bounds(day, 'weeks');
    return `${shortDate(b.start)} – ${shortDate(b.end)}`;
  }
  const d = date(day);
  return `${d.year}년 ${d.month}월`;
}
export function StatisticsPage() {
  const today = useData<Today>('/today');
  const [period, setPeriod] = useState<Period>('month');
  const [selected, setSelected] = useState('');
  const todayDate = today.data?.data.date;
  const day = selected || todayDate;
  const [habitId, setHabitId] = useState('');
  const range = day
    ? period === 'day'
      ? { start: day, end: day }
      : period === 'week'
        ? bounds(day, 'weeks')
        : period === 'month'
          ? bounds(day, 'months')
          : null
    : null;
  const params = new URLSearchParams({
    ...(range ? { from: range.start, to: range.end } : {}),
    ...(habitId ? { habit_id: habitId } : {}),
  });
  const query = useData<Stats>(`/statistics?${params}`);
  const data = query.data?.data;
  const all = useData<Stats>('/statistics');
  const habitName = (id: string) => all.data?.data.habits.find((h) => h.id === id)?.name;
  return (
    <>
      <Heading title="분석">
        <label className={styles.compactSelect}>
          <span className={styles.srOnly}>습관</span>
          <select value={habitId} onChange={(e) => setHabitId(e.target.value)}>
            <option value="">전체 습관</option>
            {all.data?.data.habits.map((h) => (
              <option value={h.id} key={h.id}>
                {h.name}
              </option>
            ))}
          </select>
        </label>
      </Heading>
      <div className={styles.statsControls}>
        <div className={styles.segmentedButtons} role="group" aria-label="기간">
          {PERIODS.map(([p, label]) => (
            <button key={p} aria-pressed={period === p} onClick={() => setPeriod(p)}>
              {label}
            </button>
          ))}
        </div>
        {period !== 'all' && day && todayDate && (
          <div className={styles.periodNav}>
            <button
              className={styles.iconButton}
              aria-label="이전 기간"
              onClick={() => setSelected(shiftDay(day, period, -1))}
            >
              <Icon name="chevronLeft" size={18} />
            </button>
            <label className={styles.periodLabel}>
              <strong>{periodTitle(day, period)}</strong>
              <span className={styles.srOnly}>기준 날짜</span>
              <input
                type="date"
                value={day}
                max={todayDate}
                onChange={(e) => setSelected(e.target.value)}
              />
            </label>
            <button
              className={styles.iconButton}
              aria-label="다음 기간"
              disabled={!range || range.end >= todayDate}
              onClick={() => {
                const next = shiftDay(day, period, 1);
                setSelected(next > todayDate ? todayDate : next);
              }}
            >
              <Icon name="chevronRight" size={18} />
            </button>
          </div>
        )}
      </div>
      <ErrorBox error={query.error} />
      {query.data?.index_warning && (
        <Notice role="status">
          인덱스를 사용할 수 없어요. 원본 Markdown에서 직접 계산한 수치예요.
        </Notice>
      )}
      {data && (
        <>
          <p className={styles.rangeNote}>
            {shortDate(data.from)} – {shortDate(data.to)} · 오늘까지
          </p>
          <div className={styles.statGrid}>
            {(
              [
                ['예정 습관 완료율', data.date_scheduled, '회'],
                ['주간 목표 (마감 기준)', data.weekly_quota, '회'],
                ['월간 목표 (마감 기준)', data.monthly_quota, '회'],
              ] as const
            ).map(([label, v], i) => (
              <article className={`${styles.panel} ${i === 0 ? styles.statHero : ''}`} key={label}>
                <span className={styles.statLabel}>{label}</span>
                <div className={styles.statValue}>
                  <strong>{percent(v.rate)}</strong>
                  <span>{v.total ? `${v.total}회 중 ${v.completed}회` : '해당 기간 없음'}</span>
                </div>
                <span className={styles.bar} aria-hidden="true">
                  <span style={{ width: `${v.rate ?? 0}%` }} />
                </span>
              </article>
            ))}
          </div>
          <div className={styles.statsColumns}>
            <section className={styles.panel}>
              <div className={styles.panelTitle}>
                <h2>일별 달성</h2>
                <span>날짜 지정 습관만</span>
              </div>
              <CalendarHeatmap data={data} />
              {!data.heatmap.length && (
                <p className={styles.muted}>이 기간에 날짜가 지정된 습관이 없어요.</p>
              )}
              <p className={styles.fieldHint}>주·월 N회 목표는 하루 단위로 실패 처리하지 않아요.</p>
            </section>
            <div className={styles.statsSide}>
              <section className={styles.panel}>
                <div className={styles.panelTitle}>
                  <h2>진행 중인 목표</h2>
                </div>
                {!data.live_quotas.length && (
                  <p className={styles.muted}>진행 중인 목표 기간이 없어요.</p>
                )}
                {data.live_quotas.map((q) => (
                  <div key={q.id} className={styles.quotaRow}>
                    <div className={styles.quotaHead}>
                      <h3>{habitName(q.habit_id)}</h3>
                      <strong>
                        {q.actual_count}/{q.target_count}
                      </strong>
                    </div>
                    <QuotaBar value={q.credited_count} max={q.target_count} />
                    <p className={styles.metaText}>
                      {shortDate(q.start)} – {shortDate(q.end)} ·{' '}
                      {q.unit === 'weeks' ? '주간 목표' : '월간 목표'}
                      {q.eligible_start !== q.start ? ' · 첫 기간 조정' : ''}
                    </p>
                  </div>
                ))}
              </section>
              <section className={`${styles.panel} ${styles.flushPanel}`}>
                <div className={styles.panelTitle}>
                  <h2>연속 달성</h2>
                  <span>현재 · 최장</span>
                </div>
                {data.habits.map((h) => {
                  const longest =
                    Object.entries(h.longest)
                      .filter(([, n]) => n > 0)
                      .map(([unit, n]) => `${n}${STREAK_UNIT[unit as keyof typeof STREAK_UNIT]}`)
                      .join(' · ') || '0';
                  return (
                    <div
                      key={h.id}
                      className={`${styles.streakRow} ${h.active ? '' : styles.manageRowMuted}`}
                    >
                      <div>
                        <h3>{h.name}</h3>
                        <p className={styles.metaText}>
                          {h.active ? '사용 중' : '비활성'}
                          {h.provisional ? ' · 잠정' : ''}
                        </p>
                      </div>
                      <strong>
                        {h.current}
                        {STREAK_UNIT[h.unit]}
                      </strong>
                      <span>{longest}</span>
                    </div>
                  );
                })}
              </section>
            </div>
          </div>
        </>
      )}
    </>
  );
}
export function HistoryPage() {
  const today = useData<Today>('/today');
  const [selected, setSelected] = useState('');
  const [offset, setOffset] = useState(0);
  const todayDate = today.data?.data.date;
  const timezone = today.data?.data.timezone ?? 'Asia/Seoul';
  const day = selected || todayDate;
  const query = useData<HistoryData>(
    `/history?${new URLSearchParams({ ...(day ? { from: day, to: day } : {}), offset: String(offset), limit: '50' })}`,
  );
  const rows = query.data?.data.rows ?? [];
  const scheduled = rows.filter((r) => r.kind === 'scheduled');
  const scheduledDone = scheduled.filter((r) => r.execution?.status === 'completed').length;
  const go = (next: string) => {
    setSelected(next);
    setOffset(0);
  };
  return (
    <>
      <Heading
        title="기록"
        eyebrow={
          <span className={styles.lockNote}>
            <Icon name="lock" size={13} />
            지난 기록은 읽기 전용이에요
          </span>
        }
      />
      {day && todayDate && (
        <div className={styles.periodNav}>
          <button
            className={styles.iconButton}
            aria-label="이전 날"
            onClick={() => go(addDays(day, -1))}
          >
            <Icon name="chevronLeft" size={18} />
          </button>
          <label className={styles.periodLabel}>
            <strong>{longDate(day)}</strong>
            <span className={styles.srOnly}>날짜 보기</span>
            <input type="date" value={day} max={todayDate} onChange={(e) => go(e.target.value)} />
          </label>
          <button
            className={styles.iconButton}
            aria-label="다음 날"
            disabled={day >= todayDate}
            onClick={() => go(addDays(day, 1))}
          >
            <Icon name="chevronRight" size={18} />
          </button>
        </div>
      )}
      <ErrorBox error={query.error} />
      {scheduled.length > 0 && (
        <div className={styles.summaryStrip}>
          <strong>
            {scheduledDone} / {scheduled.length}
          </strong>
          예정 습관 완료 · {percent((scheduledDone / scheduled.length) * 100)}
        </div>
      )}
      {rows.length > 0 && (
        <div className={styles.groupCard}>
          {rows.map((row) => {
            const e = row.execution;
            const done = e?.status === 'completed';
            const unit = e?.unit ? ` ${e.unit}` : '';
            const record = e
              ? (
                  [
                    [
                      '수행 시간',
                      e.duration_seconds !== null &&
                        `${Math.round((e.duration_seconds / 60) * 10) / 10}분`,
                    ],
                    ['목표', e.target_amount !== null && `${e.target_amount}${unit}`],
                    ['실제', e.actual_amount !== null && `${e.actual_amount}${unit}`],
                    ['난이도·완성도', e.difficulty_or_quality],
                    ['에너지', e.energy_note],
                  ] as [string, string | null | false][]
                ).filter((pair): pair is [string, string] => !!pair[1])
              : [];
            return (
              <article className={styles.historyRow} key={row.id}>
                <div className={styles.rowMain}>
                  <span
                    className={
                      done
                        ? styles.pastDone
                        : row.date === todayDate
                          ? styles.todayOpen
                          : styles.pastMissed
                    }
                    aria-label={done ? '완료' : '미완료'}
                  >
                    {done ? (
                      <Icon name="check" size={12} strokeWidth={3} />
                    ) : (
                      row.date !== todayDate && <Icon name="minus" size={10} strokeWidth={3} />
                    )}
                  </span>
                  <div className={styles.rowBody}>
                    <h2>{row.name}</h2>
                    <p className={styles.metaText}>
                      {row.kind === 'quota_activity' ? '목표 활동' : '예정'}
                      {row.scheduled_time ? ` · ${row.scheduled_time}` : ''}
                    </p>
                  </div>
                  <span className={done ? styles.rowTimeDone : styles.rowTime}>
                    {done && e?.completed_at
                      ? clockTime(e.completed_at, timezone)
                      : row.date === todayDate
                        ? '미완료 · 진행 중'
                        : '미완료'}
                  </span>
                </div>
                {record.length > 0 && (
                  <dl className={styles.record}>
                    {record.map(([k, v]) => (
                      <div key={k}>
                        <dt>{k}</dt>
                        <dd>{v}</dd>
                      </div>
                    ))}
                  </dl>
                )}
              </article>
            );
          })}
        </div>
      )}
      {query.data?.data.rows.length === 0 && (
        <Empty>이 날짜에는 예정된 습관이나 기록된 목표 활동이 없어요.</Empty>
      )}
      {query.data?.data.quota_periods.map((q) => (
        <article key={q.id} className={styles.quotaClosed}>
          <div>
            <h3>{q.unit === 'weeks' ? '주간' : '월간'} 목표 마감</h3>
            <p className={styles.metaText}>
              {habitNameFromRows(rows, q.habit_id)}
              {shortDate(q.start)} – {shortDate(q.end)}
            </p>
          </div>
          <span
            className={`${styles.badge} ${q.status === 'completed' ? styles.badgeAccent : styles.badgeNeutral}`}
          >
            {q.actual_count}/{q.target_count} · {q.status === 'completed' ? '달성' : '미달성'}
          </span>
        </article>
      ))}
      {query.data && (
        <div className={styles.pager}>
          <button
            className={styles.secondary}
            disabled={offset === 0}
            onClick={() => setOffset(Math.max(0, offset - 50))}
          >
            이전
          </button>
          <span>기록 {query.data.data.total}개</span>
          <button
            className={styles.secondary}
            disabled={offset + 50 >= query.data.data.total}
            onClick={() => setOffset(offset + 50)}
          >
            다음
          </button>
        </div>
      )}
    </>
  );
}
function habitNameFromRows(rows: HistoryData['rows'], habitId: string) {
  const name = rows.find((r) => r.habit_id === habitId)?.name;
  return name ? `${name} · ` : '';
}
export function SettingsPage() {
  const query = useRaw<{
    vault_path: string;
    timezone?: string;
    date?: string;
    source_changed?: boolean;
    index_warning?: string;
    error?: string;
    warnings?: string[];
  }>('/system/status');
  const write = useWrite();
  const [message, setMessage] = useState('');
  const run = async (action: string) => {
    setMessage('');
    try {
      await write.mutateAsync({ path: `/system/${action}` });
      setMessage(
        action === 'rebuild'
          ? '원본 Markdown으로 인덱스를 재구축했어요.'
          : '원본 Vault 검증을 통과했어요.',
      );
    } catch {
      /* Error displayed below. */
    }
  };
  const status = query.data;
  const sourceOk = status && !status.source_changed && !status.error;
  return (
    <>
      <Heading title="설정" eyebrow="기록은 Vault에 있어요. 인덱스는 언제든 다시 만들 수 있어요." />
      <ErrorBox error={query.error ?? write.error} />
      {status && (
        <section className={styles.settingsSection}>
          <h2>시스템 상태</h2>
          <dl className={styles.statusList}>
            <div>
              <dt>Obsidian 트래커 폴더</dt>
              <dd>{status.vault_path}</dd>
            </div>
            <div>
              <dt>달력 시간대</dt>
              <dd>{status.timezone ?? '확인할 수 없음'}</dd>
            </div>
            <div>
              <dt>서버 날짜</dt>
              <dd>{status.date}</dd>
            </div>
            <div>
              <dt>원본 상태</dt>
              <dd>
                <span className={sourceOk ? styles.dotOk : styles.dotWarn} aria-hidden="true" />
                {status.source_changed
                  ? '외부 변경 감지 — 직접 재구축이 필요해요'
                  : (status.error ?? '정상')}
              </dd>
            </div>
            <div>
              <dt>SQLite 인덱스</dt>
              <dd>
                <span
                  className={status.index_warning ? styles.dotWarn : styles.dotOk}
                  aria-hidden="true"
                />
                {status.index_warning ?? '정상 · 재구축 가능'}
              </dd>
            </div>
          </dl>
          {status.warnings?.map((w) => (
            <Notice key={w}>{w}</Notice>
          ))}
        </section>
      )}
      <section className={styles.settingsSection}>
        <h2>검증 및 재구축</h2>
        <div className={styles.panel}>
          <p className={styles.bodyText}>
            재구축하면 원본 Markdown을 읽어 SQLite 인덱스를 새로 만들어요. 과거 파일을 포함해 올바른
            외부 Markdown 수정 사항도 반영돼요.
          </p>
          <div className={styles.actions}>
            <button
              className={styles.secondary}
              disabled={write.isPending}
              onClick={() => void run('validate')}
            >
              Vault 검증
            </button>
            <button
              className={styles.button}
              disabled={write.isPending}
              onClick={() => void run('rebuild')}
            >
              {write.isPending ? '처리 중…' : '인덱스 재구축'}
            </button>
          </div>
          {message && (
            <p role="status" className={styles.success}>
              <Icon name="check" size={14} strokeWidth={2.5} />
              {message}
            </p>
          )}
        </div>
      </section>
      <section className={styles.settingsSection}>
        <h2>현재 지원 범위</h2>
        <div className={styles.infoPanel}>
          <p>주는 월요일 시작 · Asia/Seoul 시간대 · 오늘 기록만 수정할 수 있어요.</p>
          <p>
            기록하려면 Mac mini에 연결되어 있어야 해요. 타이머, 오프라인 기록, 하루 여러 번 완료,
            Lifebot 연동은 다음 버전에서 제공돼요.
          </p>
        </div>
      </section>
    </>
  );
}

function CalendarHeatmap({ data }: { data: Stats }) {
  const [selected, setSelected] = useState('날짜를 누르면 자세히 볼 수 있어요.');
  const values = new Map(data.heatmap.map((d) => [d.date, d]));
  const months: Record<string, string[]> = {};
  for (let day = data.from; day <= data.to; day = addDays(day, 1))
    (months[day.slice(0, 7)] ??= []).push(day);
  return (
    <>
      <div className={styles.calendarMonths}>
        {Object.entries(months).map(([month, days]) => (
          <div key={month}>
            {Object.keys(months).length > 1 && (
              <h3>
                {date(`${month}-01`).year}년 {date(`${month}-01`).month}월
              </h3>
            )}
            <div className={styles.calendarGrid}>
              {['월', '화', '수', '목', '금', '토', '일'].map((d) => (
                <span key={d} aria-hidden="true">
                  {d}
                </span>
              ))}
              {Array.from({ length: date(days[0]).dayOfWeek - 1 }, (_, i) => (
                <span key={`blank-${i}`} />
              ))}
              {days.map((day) => {
                const value = values.get(day);
                const label = value
                  ? `${shortDate(day)}: ${value.total}개 중 ${value.completed}개 (${percent(value.rate)})`
                  : `${shortDate(day)}: 예정된 습관 없음`;
                const step = value?.rate == null ? null : heatStep(value.rate);
                return (
                  <button
                    key={day}
                    type="button"
                    className={styles.calendarDay}
                    style={
                      step === null
                        ? undefined
                        : {
                            backgroundColor: HEAT[step],
                            color: step === 4 ? 'var(--heat-ink-strong)' : 'var(--heat-ink)',
                          }
                    }
                    aria-label={label}
                    title={label}
                    onClick={() => setSelected(label)}
                  >
                    {date(day).day}
                  </button>
                );
              })}
            </div>
          </div>
        ))}
      </div>
      <div className={styles.heatFooter}>
        <p className={styles.metaText} role="status">
          {selected}
        </p>
        <div className={styles.legend} aria-hidden="true">
          적음
          {HEAT.map((c) => (
            <span key={c} style={{ backgroundColor: c }} />
          ))}
          많음
        </div>
      </div>
    </>
  );
}
