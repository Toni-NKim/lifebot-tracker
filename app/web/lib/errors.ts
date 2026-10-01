/**
 * An API failure with the server's error code kept intact. `message` stays the server's
 * technical message for debugging; `koreanError` gives the text shown to the user.
 */
export class ApiError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}
// The server could not be reached; nothing was sent or saved.
export const NETWORK = 'NETWORK';

const KOREAN: Record<string, string> = {
  REVISION_CONFLICT: '다른 기기에서 기록이 변경됐어요. 새로고침 후 다시 확인해주세요.',
  [NETWORK]: '오프라인 상태에서는 기록할 수 없어요.',
  STATE_UNAVAILABLE: '저장소에 접근할 수 없어 기록하지 못했어요.',
  VAULT_UNAVAILABLE: '저장소에 접근할 수 없어 기록하지 못했어요.',
  INDEX_UNAVAILABLE: '통계 인덱스를 사용할 수 없어요. 설정에서 인덱스를 재구축해주세요.',
  VAULT_BUSY: '다른 프로그램이 저장소를 사용 중이에요. 잠시 후 다시 시도해주세요.',
  EXTERNAL_CHANGE: '저장소 파일이 외부에서 변경됐어요. 설정에서 인덱스를 재구축해주세요.',
  DAY_LOCKED: '지난 날짜의 기록은 바꿀 수 없어요.',
  NOT_SCHEDULED: '오늘은 이 습관을 기록할 수 없어요.',
  VALIDATION_ERROR: '입력한 값을 확인해주세요.',
  NOT_FOUND: '항목을 찾을 수 없어요. 새로고침 후 다시 확인해주세요.',
  IDEMPOTENCY_CONFLICT: '같은 요청이 이미 처리됐어요. 새로고침 후 다시 확인해주세요.',
  INVALID_VAULT: '저장소 파일에 문제가 있어요. 설정에서 저장소를 검증해주세요.',
  CONFIGURATION_ERROR: '서버 설정에 문제가 있어요.',
  FORBIDDEN: '이 기기에서는 요청할 수 없어요.',
  UNSUPPORTED_MEDIA_TYPE: '요청 형식이 올바르지 않아요.',
};
// Validation messages the user can act on, more specific than "check the input".
const VALIDATION: [RegExp, string][] = [
  [/cannot start in the past/i, '시작일은 오늘 이후여야 해요.'],
  [/Deleted Habits cannot be restored/i, '삭제된 습관은 복원할 수 없어요.'],
  [/inheritance requires a Routine/i, '루틴 설정을 따르려면 루틴을 먼저 선택해주세요.'],
  [/Parent Routine is unavailable/i, '선택한 루틴을 적용일에 사용할 수 없어요.'],
  [/Invalid calendar date/i, '날짜 형식이 올바르지 않아요.'],
  [/Range start must be before range end/i, '시작 날짜가 끝 날짜보다 늦어요.'],
];

export const errorCode = (error: Error) => (error instanceof ApiError ? error.code : undefined);

/** Concise Korean text for an error; unknown failures keep a generic message. */
export function koreanError(error: Error): string {
  const code = errorCode(error);
  if (!code) return '요청을 처리하지 못했어요. 다시 시도해주세요.';
  // "New Habits cannot start in the past" arrives as DAY_LOCKED.
  const specific = VALIDATION.find(([pattern]) => pattern.test(error.message));
  if (specific && (code === 'VALIDATION_ERROR' || code === 'DAY_LOCKED')) return specific[1];
  return KOREAN[code] ?? '요청을 처리하지 못했어요. 다시 시도해주세요.';
}
