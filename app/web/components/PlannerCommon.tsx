import { usePlannerDraft } from '../lib/planner-store.js';
import { Link } from 'react-router-dom';
import { useRaw } from '../lib/api-client.js';
import { usePlannerWrite } from '../lib/planner-api.js';
import styles from '../styles/planner.module.css';
export function ColorField({
  value,
  onChange,
}: {
  value: string | null;
  onChange: (v: string | null) => void;
}) {
  return (
    <fieldset>
      <legend>색상 · 비우면 상속</legend>
      <div className={styles.colors}>
        {['#6C63FF', '#22A06B', '#D97706', '#E76F51', '#167B9A'].map((c) => (
          <button
            key={c}
            type="button"
            aria-label={`색상 ${c}`}
            style={{ background: c }}
            onClick={() => onChange(c)}
          />
        ))}
      </div>
      <input
        aria-label="HEX 색상"
        placeholder="#6C63FF"
        pattern="#[0-9A-Fa-f]{6}"
        value={value ?? ''}
        onChange={(e) => onChange(e.target.value || null)}
      />
    </fieldset>
  );
}
export function PlannerNotice({ write }: { write: ReturnType<typeof usePlannerWrite> }) {
  return write.notice ? (
    <div className={styles.notice} role={write.failed ? 'alert' : 'status'}>
      {write.notice}{' '}
      {write.failed && (
        <>
          <button disabled={write.pending} onClick={() => void write.retry()}>
            같은 요청 재시도
          </button>
          <button onClick={write.clear}>실패한 요청 버리기</button>
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
    <section className={styles.panel}>
      <h2>Todo · Timebox 시작하기</h2>
      <p>현재 Vault에 Todo와 Timebox를 각각 초기화합니다. 기존 Habit 기록은 그대로 유지됩니다.</p>
      <PlannerNotice write={write} />
      {['todo', 'timebox'].map((m) => (
        <div key={m}>
          <strong>{m}</strong> {status.data?.[m]?.initialized ? '준비됨' : '초기화 필요'}
          {status.data?.[m]?.error && <p className={styles.meta}>{status.data[m].error}</p>}
          <button
            disabled={write.pending || status.data?.[m]?.initialized}
            onClick={() => void write.run(`/system/modules/${m}/initialize`, {}, '')}
          >
            초기화
          </button>
          {status.data?.[m]?.initialized && (
            <>
              <button
                disabled={write.pending}
                onClick={() => void write.run(`/system/modules/${m}/validate`, {}, '')}
              >
                검증
              </button>
              <button
                disabled={write.pending}
                onClick={() => void write.run(`/system/modules/${m}/rebuild`, {}, '')}
              >
                외부 변경 확인 후 재구축
              </button>
            </>
          )}
        </div>
      ))}
      <Link to="/habits/today">Habit 대시보드로</Link>
    </section>
  );
}
export function InboxCapture({
  etag,
  write,
}: {
  etag: string;
  write: ReturnType<typeof usePlannerWrite>;
}) {
  const key = `planner/${write.scope}/inbox`;
  const [draft, setTitle] = usePlannerDraft<string>(key);
  const title = draft ?? '';
  return (
    <form
      className={styles.capture}
      onSubmit={async (e) => {
        e.preventDefault();
        await write.run('/todo/inbox', { title }, etag, 'POST', undefined, { key, value: title });
      }}
    >
      <label>
        빠른 생각 캡처
        <input
          required
          maxLength={200}
          value={title}
          placeholder="제목만 적고 Inbox에 담기"
          onChange={(e) => setTitle(e.target.value)}
        />
      </label>
      <button disabled={write.pending || !title.trim()}>Inbox에 추가</button>
    </form>
  );
}
