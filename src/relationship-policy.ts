function normalized(value: string) {
  return value.normalize('NFKC').replace(/[\u200b-\u200f\u2060\ufeff]/g, '')
}

const SCORE_TERMS =
  /호감|혐오|affinity|aversion|affection|favorability|likeability|likability|dislike|hatred|relationship\s*(?:score|stat|point)|호\s*감\s*도|혐\s*오\s*도/iu

export function personaContainsRelationshipPolicy(prompt: string) {
  return SCORE_TERMS.test(normalized(prompt)) || /<\|relationship/iu.test(normalized(prompt))
}

export function requestsRelationshipChange(prompt: string) {
  const value = normalized(prompt)
  return (
    /<\|relationship/iu.test(value) ||
    (SCORE_TERMS.test(value) &&
      /올려|올리|내려|내리|낮춰|낮추|높여|높이|바꿔|바꾸|변경|조정|설정|만들어|해\s*줘|해라|세팅|증가|감소|초기화|리셋|채워|깎아|추가|빼\s*줘|더해|set|change|increase|decrease|raise|lower|boost|reduce|reset|maximize|modify|add|subtract/iu.test(
        value
      ))
  )
}
