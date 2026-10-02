import { usePlannerDraft } from '../lib/planner-store.js';
import { Link } from 'react-router-dom';
import { useRaw } from '../lib/api-client.js';
import { usePlannerWrite } from '../lib/planner-api.js';
import { Icon } from './icons.js';
import styles from '../styles/planner.module.css';
const SWATCHES = ['#6C63FF', '#22A06B', '#D97706', '#E76F51', '#167B9A'];
const HEX = /^#[0-9A-Fa-f]{6}$/;
export function ColorField({
  value,
  onChange,
}: {
  value: string | null;
  onChange: (v: string | null) => void;
}) {
  return (
    <fieldset className={styles.colorField}>
      <legend>색상 · 비우면 상속</legend>
      <div className={styles.colors}>
        {SWATCHES.map((c) => (
          <button
            key={c}
            type="button"
            aria-label={`색상 ${c}`}
            aria-pressed={value?.toUpperCase() === c}
            style={{ background: c }}
            onClick={() => onChange(c)}
          />
        ))}
      </div>
      <div className={styles.hexInput}>
        <span
          className={styles.hexPreview}
          aria-hidden="true"
          style={value && HEX.test(value) ? { background: value, borderStyle: 'solid' } : undefined}
        />
        <input
          aria-label="HEX 색상"
          placeholder="#6C63FF"
          pattern="#[0-9A-Fa-f]{6}"
          value={value ?? ''}
          onChange={(e) => onChange(e.target.value || null)}
        />
        {value && (
          <button
            type="button"
            className={`${styles.ghostButton} ${styles.small}`}
            onClick={() => onChange(null)}
          >
            상속으로 되돌리기
          </button>
        )}
      </div>
    </fieldset>
  );
}
export function PlannerNotice({ write }: { write: ReturnType<typeof usePlannerWrite> }) {
  return write.notice ? (
    <div className={styles.notice} role={write.failed ? 'alert' : 'status'}>
      <p className={styles.noticeText}>{write.notice}</p>
      {write.failed && (
        <>
          <button
            className={`${styles.secondary} ${styles.small}`}
            disabled={write.pending}
            onClick={() => void write.retry()}
          >
            같은 요청 재시도
          </button>
          <button className={`${styles.ghostButton} ${styles.small}`} onClick={write.clear}>
            실패한 요청 버리기
          </button>
        </>
      )}
    </div>
  ) : null;
}
export function ModuleSetup() {
  const status =
    useRaw<Record<string, { initialized: boolean; error?: string }>>('/system/modules');
  const write = usePlannerWrite();
  return (
    <section className={`${styles.panel} ${styles.setup}`}>
      <div className={styles.panelTitle}>
        <h2>Todo · Timebox 시작하기</h2>
      </div>
      <p className={styles.muted}>
        현재 Vault에 Todo와 Timebox를 각각 초기화합니다. 기존 Habit 기록은 그대로 유지됩니다.
      </p>
      <PlannerNotice write={write} />
      {['todo', 'timebox'].map((m) => (
        <div key={m} className={styles.setupRow}>
          <strong>{m}</strong>
          <span
            className={`${styles.badge} ${status.data?.[m]?.initialized ? styles.badgeAccent : styles.badgeCaution}`}
          >
            {status.data?.[m]?.initialized ? '준비됨' : '초기화 필요'}
          </span>
          {status.data?.[m]?.error && <p className={styles.meta}>{status.data[m].error}</p>}
          <button
            className={`${styles.primary} ${styles.small}`}
            disabled={write.pending || status.data?.[m]?.initialized}
            onClick={() => void write.run(`/system/modules/${m}/initialize`, {}, '')}
          >
            초기화
          </button>
          {status.data?.[m]?.initialized && (
            <>
              <button
                className={`${styles.secondary} ${styles.small}`}
                disabled={write.pending}
                onClick={() => void write.run(`/system/modules/${m}/validate`, {}, '')}
              >
                검증
              </button>
              <button
                className={`${styles.secondary} ${styles.small}`}
                disabled={write.pending}
                onClick={() => void write.run(`/system/modules/${m}/rebuild`, {}, '')}
              >
                외부 변경 확인 후 재구축
              </button>
            </>
          )}
        </div>
      ))}
      <Link to="/habits/today" className={`${styles.ghostButton} ${styles.small}`}>
        Habit 대시보드로
      </Link>
    </section>
  );
}
// One line: type a thought and keep going. Title only; it is sorted out later.
export function InboxCapture({
  etag,
  write,
  compact = false,
}: {
  etag: string;
  write: ReturnType<typeof usePlannerWrite>;
  compact?: boolean;
}) {
  const key = `planner/${write.scope}/inbox`;
  const [draft, setTitle] = usePlannerDraft<string>(key);
  const title = draft ?? '';
  return (
    <form
      className={`${styles.capture} ${compact ? styles.captureCompact : ''}`}
      onSubmit={async (e) => {
        e.preventDefault();
        await write.run('/todo/inbox', { title }, etag, 'POST', undefined, { key, value: title });
      }}
    >
      <label>
        <span className={compact ? styles.srOnly : undefined}>빠른 생각 캡처</span>
        <input
          required
          maxLength={200}
          value={title}
          placeholder="떠오른 생각을 적고 Enter"
          onChange={(e) => setTitle(e.target.value)}
        />
      </label>
      <button
        className={compact ? styles.captureIcon : styles.primary}
        aria-label={compact ? 'Inbox에 추가' : undefined}
        disabled={write.pending || !title.trim()}
      >
        {compact ? <Icon name="plus" size={18} strokeWidth={2.2} /> : 'Inbox에 추가'}
      </button>
    </form>
  );
}
