export type ArchiveSearchFailure =
  | 'configuration'
  | 'rate_limit'
  | 'timeout'
  | 'authentication'
  | 'model_request'
  | 'output_limit'
  | 'incomplete'
  | 'invalid_output'
  | 'tool_protocol'
  | 'unavailable'

const MESSAGES: Record<ArchiveSearchFailure, string> = {
  configuration: '이 채널은 검색 대상으로 설정되지 않았거나 검색 설정이 변경되었습니다.',
  rate_limit: '검색 요청 한도에 도달했습니다. 잠시 후 다시 시도해 주세요.',
  timeout: '검색 처리 시간이 초과되었습니다. 잠시 후 다시 시도해 주세요.',
  authentication:
    '검색 AI 서비스 인증에 실패했습니다. 관리자가 /a에서 OpenAI 연결 설정을 확인해야 합니다.',
  model_request:
    '검색 모델이 요청을 거부했습니다. 관리자가 /a에서 검색 모델의 사용 가능 여부와 JSON 응답·도구 호출 지원을 확인해야 합니다.',
  output_limit: '검색 모델이 응답을 완성하기 전에 토큰 한도에 도달했습니다.',
  incomplete: '검색 모델의 응답이 완료되지 않았습니다. 잠시 후 다시 시도해 주세요.',
  invalid_output: '검색 모델의 최종 JSON 응답 또는 원문 링크를 검증하지 못했습니다.',
  tool_protocol: '검색 모델이 올바른 SQL 도구 호출을 생성하지 못했습니다.',
  unavailable: '검색 서비스 연결 또는 응답 처리에 실패했습니다. 잠시 후 다시 시도해 주세요.'
}

export class ArchiveSearchError extends Error {
  constructor(
    readonly category: ArchiveSearchFailure,
    readonly status?: number
  ) {
    super(MESSAGES[category])
  }
}

export function archiveSearchError(error: unknown): ArchiveSearchError {
  if (error instanceof ArchiveSearchError) return error
  if (error instanceof SyntaxError || (error instanceof Error && error.name === 'ZodError'))
    return new ArchiveSearchError('invalid_output')
  if (
    error instanceof Error &&
    /^(?:TimeoutError|AbortError|APIConnectionTimeoutError)$/.test(error.name)
  )
    return new ArchiveSearchError('timeout')
  const status =
    error &&
    typeof error === 'object' &&
    'status' in error &&
    typeof error.status === 'number' &&
    Number.isInteger(error.status) &&
    error.status >= 400 &&
    error.status <= 599
      ? error.status
      : undefined
  if (status === 401 || status === 403) return new ArchiveSearchError('authentication', status)
  if (status === 429) return new ArchiveSearchError('rate_limit', status)
  if (status === 408 || status === 504) return new ArchiveSearchError('timeout', status)
  if (status && status < 500) return new ArchiveSearchError('model_request', status)
  return new ArchiveSearchError('unavailable', status)
}
