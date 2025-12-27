# RPR STREAM NFA 개념 설계서

**Author:** Henson Choi
**Email:** assam258@gmail.com
**Date:** 2025-12-28
**Last Updated:** 2025-12-30

---

## 1. 개요

### 1.1 목적

SQL Row Pattern Recognition (RPR)의 PATTERN 절을 NFA로 구현하기 위한 개념 설계입니다.

### 1.2 설계 목표

| 목표 | 설명 |
|------|------|
| **성능** | Flink 수준의 효율성 |
| **단순성** | 플랫 배열로 캐시 효율적 |
| **안전성** | 상태/컨텍스트 수 제한 |
| **확장성** | RELUCTANT, PERMUTE 등 확장 가능 |

### 1.3 핵심 구조

```
┌───────────────────────────────────────────────────────────────────┐
│  NFAExecutor                                                      │
│                                                                   │
│  Pattern ─────────▶ PatternElement[] (플랫 배열)                  │
│      │               [0]A → [1]B+ → [2]C* → [3]#FIN               │
│      ▼                                                            │
│  Context[] ────────▶ MatchState[]                                 │
│      │                   │                                        │
│      ├─ id               ├─ elementIndex                          │
│      ├─ matchStart       ├─ counts[]                              │
│      ├─ matchEnd         └─ matchedPaths[] ← CLASSIFIER 지원      │
│      └─ isCompleted                                               │
└───────────────────────────────────────────────────────────────────┘
```

### 1.4 주요 설계 결정

| 항목 | 설명 |
|------|------|
| 플랫 배열 패턴 | 캐시 효율, 단순한 전이 |
| 해시 기반 상태 비교 | O(1) Merge |
| matchedPaths | CLASSIFIER() 함수 지원 |
| 상태 머지 시 경로 병합 | mergePaths()로 중복 경로 제거 |
| 컨텍스트 흡수 | O(N) → O(1) 메모리 |
| 잠재적 완료 (potential) | 무한 반복 패턴의 최장 매칭 지원 |

### 1.5 지원 기능

| 기능 | 상태 |
|------|------|
| 수량자 (?, *, +, {n,m}) | 지원 |
| 대안선택 (\|) | 지원 |
| 그룹 반복 | 지원 |
| 중첩 그룹 | 지원 |
| 상태 머지 | 지원 (경로 병합 포함) |
| 컨텍스트 흡수 | 지원 |
| 최장 매칭 (Greedy) | 지원 |
| CLASSIFIER() | 지원 (matchedPaths) |
| RELUCTANT | 확장 예정 |
| PERMUTE | 확장 예정 |

---

## 2. 자료구조

### 2.1 Pattern (패턴)

파싱된 PATTERN 절을 플랫 배열로 표현합니다.

```
┌─────────────────────────────────────────────────────────┐
│ Pattern                                                 │
├─────────────────────────────────────────────────────────┤
│ num_elements: 4          (패턴 요소 개수)               │
│ num_vars: 3              (변수 개수: A, B, C)           │
│ max_depth: 1             (최대 중첩 깊이)               │
├─────────────────────────────────────────────────────────┤
│ elements[]:                                             │
│   [0] PatternElement (A)                                │
│   [1] PatternElement (B+)                               │
│   [2] PatternElement (C*)                               │
│   [3] PatternElement (#FIN)                             │
└─────────────────────────────────────────────────────────┘
```

### 2.2 PatternElement (패턴 요소)

각 패턴 요소의 구조입니다. **var_index 기반 타입 시스템**을 사용합니다.

```
┌─────────────────────────────────────────────────────────┐
│ PatternElement                                          │
├─────────────────────────────────────────────────────────┤
│ var_index    : 변수 인덱스 또는 특수값                  │
│                - 일반 변수: 0, 1, 2, ... (0~N-1)        │
│                - 대안 시작: #ALT (-1)                   │
│                - 그룹 종료: #END (-2)                   │
│                - 최종 상태: #FIN (-3)                   │
│ depth        : 중첩 깊이 (0 = 최외곽)                   │
│ min          : 최소 반복 횟수                           │
│ max          : 최대 반복 횟수 (무한 = INT64_MAX)        │
│ next         : 완료 시 다음 요소 (-1 = 패턴 종료)       │
│ jump         : 용도별 다른 의미                         │
│                - GROUP_END: 그룹 시작으로 루프백        │
│                - VAR in ALT: 다음 대안 시작 인덱스      │
└─────────────────────────────────────────────────────────┘

타입 판별:
  is_var(elem) { return elem.var_index >= 0; }
  is_alt(elem) { return elem.var_index == -1; }
  is_end(elem) { return elem.var_index == -2; }
  is_fin(elem) { return elem.var_index == -3; }
  can_skip(elem) { return elem.min == 0; }
```

**수량자 표현:**

| 표기법 | min | max | 설명 |
|--------|-----|-----|------|
| A | 1 | 1 | 정확히 1회 |
| A? | 0 | 1 | 0 또는 1회 |
| A* | 0 | ∞ | 0회 이상 |
| A+ | 1 | ∞ | 1회 이상 |
| A{2,5} | 2 | 5 | 2~5회 |

### 2.3 MatchState (매칭 상태)

NFA의 런타임 상태입니다. CLASSIFIER() 지원을 위해 경로 히스토리를 포함합니다.

```
┌─────────────────────────────────────────────────────────┐
│ MatchState                                              │
├─────────────────────────────────────────────────────────┤
│ elementIndex  : 현재 패턴 위치 (#FIN = 완료 가능)       │
│ counts[]      : 깊이별 반복 횟수 [max_depth + 1]        │
│ consumed      : 현재 row에서 VAR를 소비했는지 여부      │
│ matchedPaths  : 매칭 경로 배열 [[varName, ...], ...]    │
└─────────────────────────────────────────────────────────┘

** matchedPaths 필드 (CLASSIFIER 지원) **
- 각 상태가 어떤 경로로 도달했는지 추적
- 배열의 배열: 여러 경로가 동일 상태에 머지될 수 있음
- 상태 머지 시 경로들도 병합 (mergePaths)
- 예: [['A', 'B'], ['A', 'C', 'B']] - 두 경로가 같은 상태에 도달

** consumed 필드 **
- 현재 row에서 VAR를 실제로 소비(매칭)했는지 추적
- 완료 시 matchEnd 결정에 사용:
  - consumed=true  → matchEnd = currentRow
  - consumed=false → matchEnd = currentRow - 1
- 매 row 시작 시 false로 리셋
```

**상태 동등성:**
- 두 상태가 동일 = `elementIndex`와 `counts[]`가 모두 같음
- `consumed`, `matchedPaths`는 동등성 비교에 포함되지 않음
- 동일 상태 발견 시 경로만 병합 (mergePaths)

### 2.4 MatchContext (매칭 컨텍스트)

동일 시작점의 상태들을 그룹화합니다.

```
┌─────────────────────────────────────────────────────────┐
│ MatchContext                                            │
├─────────────────────────────────────────────────────────┤
│ id                   : 고유 컨텍스트 ID                 │
│ matchStart           : 매칭 시작 행                     │
│ matchEnd             : 매칭 종료 행 (완료 시 설정)      │
│ isCompleted          : 최종 완료 여부                   │
│ states[]             : 활성 상태 배열                   │
└─────────────────────────────────────────────────────────┘

** 상태 구분 **
- active: states.length > 0 && !isCompleted
- potential: matchEnd >= 0 && !isCompleted (완료 가능하지만 더 진행 중)
- matched: isCompleted (최종 완료)

** 잠재적 완료 (Potential Match) **
- 무한 반복 요소(A+, B*)가 패턴 끝에 있을 때 발생
- 더 긴 매칭을 위해 계속 진행
- VAR 불매칭 시 최종 완료로 전환
```

### 2.5 NFAExecutor (실행기)

전체 NFA 실행을 관리합니다.

```
┌─────────────────────────────────────────────────────────┐
│ NFAExecutor                                             │
├─────────────────────────────────────────────────────────┤
│ pattern       : Pattern 참조                            │
│ currentRow    : 현재 처리 중인 행                       │
│ contexts[]    : 활성 컨텍스트 배열                      │
│ history[]     : 행별 스냅샷 기록 (디버깅용)             │
└─────────────────────────────────────────────────────────┘

processRow(trueVars) 반환값:
  - row: 처리한 행 번호
  - contexts: 컨텍스트 스냅샷 배열
  - absorptions: 흡수 기록 [{absorbedId, byId, ...}]
  - stateMerges: 상태 머지 기록 [{contextId, elementIndex, ...}]
  - logs: 디버그 로그 배열
```

---

## 3. 패턴 파싱

### 3.1 파이프라인

```
패턴 문자열 → 토크나이저 → AST 파서 → 최적화 → 평탄화 → Pattern
     │            │            │          │          │
     │            ▼            ▼          ▼          ▼
     │       [LPAREN,      {type:SEQ,   최적화된    PatternElement[]
     │        VAR(A),       items:[     AST         + next/jump 설정
     │        QUANT,        ...]}
     │        ...]
     ▼
 "( A B ){2,3}"
```

### 3.2 토큰 및 AST

**토큰 타입:**

| 토큰 | 설명 | 예시 |
|------|------|------|
| LPAREN | 그룹 시작 | `(` |
| RPAREN | 그룹 끝 | `)` |
| VAR | 변수 | `A`, `B1`, `var_name` |
| QUANT | 수량자 | `?`, `*`, `+`, `{2,3}` |
| ALT | 대안 구분자 | `\|` |

**AST 노드 타입:**

```javascript
{ type: 'SEQ', items: [...] }           // 시퀀스: A B C
{ type: 'VAR', name: 'A', min: 2, max: 3 }  // 변수: A{2,3}
{ type: 'GROUP', content: {...}, min: 1, max: 3 }  // 그룹
{ type: 'ALT', alternatives: [...] }    // 대안: A | B | C
```

**AST 최적화:**

| 최적화 | 변환 전 | 변환 후 |
|--------|---------|---------|
| unwrapGroups | `((A))` | `A` |
| unwrapGroups | `(A B){1,1}` | `A B` |
| removeDuplicates | `A \| B \| A` | `A \| B` |

### 3.3 평탄화 예제

#### 단순 시퀀스: `A B+ C*`

```
┌─────┬───────────┬───────┬─────┬─────┬──────┬──────┐
│ idx │ var_index │ depth │ min │ max │ next │ jump │
├─────┼───────────┼───────┼─────┼─────┼──────┼──────┤
│  0  │     0 (A) │   0   │  1  │  1  │   1  │  -1  │
│  1  │     1 (B) │   0   │  1  │  ∞  │   2  │  -1  │
│  2  │     2 (C) │   0   │  0  │  ∞  │   3  │  -1  │
│  3  │    -3     │   0   │  1  │  1  │  -1  │  -1  │  ← #FIN
└─────┴───────────┴───────┴─────┴─────┴──────┴──────┘
```

#### 대안선택: `A | B | C`

```
┌─────┬───────────┬───────┬─────┬─────┬──────┬──────┐
│ idx │ var_index │ depth │ min │ max │ next │ jump │
├─────┼───────────┼───────┼─────┼─────┼──────┼──────┤
│  0  │    -1     │   0   │  1  │  1  │   1  │  -1  │  ← #ALT
│  1  │   0 (A)   │   1   │  1  │  1  │   4  │   2  │  ← jump→다음 대안
│  2  │   1 (B)   │   1   │  1  │  1  │   4  │   3  │
│  3  │   2 (C)   │   1   │  1  │  1  │   4  │  -1  │  ← 마지막 대안
│  4  │    -2     │   0   │  1  │  1  │   5  │   1  │  ← #END
│  5  │    -3     │   0   │  1  │  1  │  -1  │  -1  │  ← #FIN
└─────┴───────────┴───────┴─────┴─────┴──────┴──────┘

#ALT.next → 첫 번째 대안, 각 대안의 jump → 다음 대안
```

#### 그룹 반복: `(A B){2,3} C`

```
┌─────┬───────────┬───────┬─────┬─────┬──────┬──────┐
│ idx │ var_index │ depth │ min │ max │ next │ jump │
├─────┼───────────┼───────┼─────┼─────┼──────┼──────┤
│  0  │   0 (A)   │   1   │  1  │  1  │   1  │  -1  │
│  1  │   1 (B)   │   1   │  1  │  1  │   2  │  -1  │
│  2  │    -2     │   0   │  2  │  3  │   3  │   0  │  ← #END (depth=0!)
│  3  │   2 (C)   │   0   │  1  │  1  │   4  │  -1  │
│  4  │    -3     │   0   │  1  │  1  │  -1  │  -1  │  ← #FIN
└─────┴───────────┴───────┴─────┴─────┴──────┴──────┘

** 중요: #END의 depth는 부모 레벨(0)을 사용 **
   - 그룹 내부 요소(A, B)는 depth=1
   - #END는 그룹 반복 횟수를 counts[0]에서 추적
```

---

## 4. 상태 관리

### 4.1 상태 Fork

분기가 필요할 때 상태를 복제합니다.

```
Fork 발생 상황:
1. 대안선택에서 여러 대안이 매칭될 때
2. 수량자 범위 내에서 "계속" vs "종료" 선택 시

Fork 전:                    Fork 후:
┌─────────────┐            ┌─────────────┐
│   State A   │            │   State A   │ (stay)
│ elem: 1     │     ──▶    │ elem: 1     │
│ counts:[2]  │            │ counts:[2]  │
└─────────────┘            └─────────────┘
                           ┌─────────────┐
                           │   State B   │ (advance)
                           │ elem: 2     │
                           │ counts:[0]  │
                           └─────────────┘
```

**Fork 비용: O(depth)** - counts[] 배열만 복사

### 4.2 상태 Merge

동일한 상태는 하나만 유지하되, 경로 히스토리는 병합합니다.

```
Merge 조건: elementIndex와 counts[]가 동일

Merge 전:
┌───────────────────────┐   ┌───────────────────────┐
│   State A             │   │   State B             │
│ elem: 2               │   │ elem: 2               │  ← 같은 위치
│ counts:[1]            │   │ counts:[1]            │  ← 같은 카운트
│ paths:[['A','B']]     │   │ paths:[['A','C']]     │  ← 다른 경로
└───────────────────────┘   └───────────────────────┘

Merge 후:
┌───────────────────────┐
│   State A (merged)    │
│ elem: 2               │
│ counts:[1]            │
│ paths:[['A','B'],     │  ← 경로 병합됨
│        ['A','C']]     │
└───────────────────────┘

** 동일 상태 = 동일 미래 → 하나만 추적, 경로는 모두 보존 **
```

### 4.3 상태 폭발 방지

복잡한 패턴에서 무한 루프로 인한 상태 폭발을 방지합니다.

**문제 상황:**
```
패턴: ((A|B)+ (C|D)*){1,2}

상태 폭발 시나리오:
  Row에서 C, D 모두 불매칭 시:
    1. (C|D)* → #ALT 진입
    2. 모든 대안(C, D) 불매칭
    3. #END 도달 (min=0 만족)
    4. #END.jump → #ALT 반복 ← 무한 루프!
```

**해결책:**
```
┌────────────────────────────────────────────────────────────┐
│  상태 폭발 방지 규칙:                                       │
│                                                            │
│  1. epsilon 전이 중 min=0 그룹의 #END 도달 시:             │
│     → repeat 경로 생성 안 함 (continue만)                  │
│                                                            │
│  2. #ALT에서 모든 대안 불매칭 후 #END 탈출 시:             │
│     → repeat 경로 생성 안 함 (continue만)                  │
│                                                            │
│  3. 같은 row에서 같은 상태(elem_idx + counts)는 1개만 유지 │
│     → 해시 기반 중복 제거                                  │
└────────────────────────────────────────────────────────────┘
```

### 4.4 counts[] 리셋 규칙

```
┌────────────────────────┬─────────────────┬─────────────────────┐
│         상황           │   리셋 범위     │        설명         │
├────────────────────────┼─────────────────┼─────────────────────┤
│ depth N에서 jump       │ counts[N+1:]    │ 내부 그룹만 리셋    │
│ depth N에서 next       │ 리셋 없음       │ 그룹 완료, 진행     │
│ 새 컨텍스트 생성       │ 전체 0 초기화   │ 새 시작             │
└────────────────────────┴─────────────────┴─────────────────────┘

예: (A B){2,3} 에서 #END 도달 시
  counts[0] = 1: < min(2) → 반드시 jump
  counts[0] = 2: >= min, < max → fork (jump + next)
  counts[0] = 3: == max → 반드시 next
```

### 4.5 최장 매칭 (Longest Match)

NFA는 가능한 가장 긴 매칭을 찾습니다.

```
┌────────────────────────────────────────────────────────────────────┐
│  최장 매칭 원리:                                                    │
│                                                                    │
│  1. 완료 가능 시점을 발견해도 즉시 종료하지 않음                   │
│  2. 잠재적 완료(potential match)로 기록하고 계속 진행              │
│  3. 더 이상 진행할 상태가 없을 때 최종 완료                        │
│                                                                    │
│  예: A B+ C* 패턴, 입력 [A, B, B, 빈 입력]                         │
│                                                                    │
│  Row 0: A 매칭 → B+ 대기                                           │
│  Row 1: B 매칭 → 잠재적 완료 (matchEnd=1), B+ 계속 유지            │
│  Row 2: B 매칭 → 잠재적 완료 갱신 (matchEnd=2)                     │
│  Row 3: 빈 입력 → 최종 완료 (rows 0-2)                             │
└────────────────────────────────────────────────────────────────────┘
```

**구현:**
```
for each state transition:
    if completion found:
        ctx.matchEnd = row        // 잠재적 완료 시점 기록
        ctx.addCompletedPath(path)
        continue processing

after all transitions:
    if no more active states:
        if ctx.matchEnd >= 0:
            ctx.isCompleted = true  // 최종 완료
    else:
        continue to next row        // 잠재적 완료 상태 유지
```

---

## 5. 컨텍스트 관리

### 5.1 컨텍스트 흡수

**문제: 컨텍스트 폭발**
```
패턴: A+, 모든 행이 A=T인 경우:

Row 0: Context 0 생성
Row 1: Context 0 진행, Context 1 생성
Row 2: Context 0,1 진행, Context 2 생성
...
Row N: N개의 컨텍스트 → O(N) 메모리!
```

**해결: 흡수**
```
흡수 원리:
- Context 0이 counts=[4]에 있다면,
- 이전에 counts=[3], [2], [1]을 모두 거쳐왔음
- 따라서 뒤의 컨텍스트들은 불필요 (같은 미래)

흡수 후: Context 0만 유지
메모리: O(N) → O(1)
```

**흡수 조건:**

| 조건 | 흡수 가능 |
|------|----------|
| SKIP PAST LAST ROW | O |
| SKIP TO NEXT ROW | X (모든 매칭 필요) |
| max = ∞ (*, +) | O |
| max = 유한 ({n,m}, ?) | X |

### 5.2 SKIP 옵션

**SKIP PAST LAST ROW (기본값):**
```
패턴: A B+
입력: A B B A B

매칭 완료 시 → 다음 매칭은 완료 지점 이후부터
결과: 1개 매칭 (row 0~2)
```

**SKIP TO NEXT ROW:**
```
패턴: A B+
입력: A B B (row 1에서 A, B 둘 다 true)

중첩 허용 → 매 row마다 새 컨텍스트 시작 가능
결과: 2개 매칭 (row 0~2, row 1~2)
```

---

## 6. 실행 예제

### 6.1 단순 시퀀스: `A B+ C`

```
패턴: A B+ C
elements: [0:A, 1:B+, 2:C, 3:#FIN]

입력 데이터:
┌─────┬───┬───┬───┐
│ row │ A │ B │ C │
├─────┼───┼───┼───┤
│  0  │ T │ F │ F │
│  1  │ F │ T │ F │
│  2  │ F │ T │ F │
│  3  │ F │ F │ T │
└─────┴───┴───┴───┘

실행 과정:

[Row 0] A=T
  Context 생성 (matchStart: 0)
  State: elementIndex=1(B대기), counts=[1]

[Row 1] B=T
  State: elementIndex=1(B), counts=[1,1]

[Row 2] B=T
  State: elementIndex=1(B), counts=[1,2]

[Row 3] C=T
  B 불만족, min 충족 → C로 전이
  State: elementIndex=3(#FIN), matchEnd=3

결과: 매칭 범위 row 0~3
```

### 6.2 최장 매칭: `A B+ C*`

```
패턴: A B+ C*
elements: [0:A, 1:B+, 2:C*, 3:#FIN]

입력 데이터:
┌─────┬───┬───┬───┐
│ row │ A │ B │ C │
├─────┼───┼───┼───┤
│  0  │ T │ F │ F │
│  1  │ F │ T │ F │
│  2  │ F │ T │ F │
│  3  │ F │ F │ F │  ← 빈 입력
└─────┴───┴───┴───┘

실행 과정:

[Row 0] A=T
  State 1: elementIndex=1(B+), consumed=true

[Row 1] B=T (count >= min → Fork)
  State 1: elementIndex=1(B+), counts=[1,1]
  State 2: elementIndex=3(#FIN), 완료 가능

[Row 2] B=T (Fork)
  State 1: elementIndex=1(B+), counts=[1,2]
  State 2: 폐기 (더 짧은 매칭)
  State 3: elementIndex=3(#FIN), 완료 가능

[Row 3] 빈 입력
  State 1: 소멸 (B 불매칭)
  State 3: #FIN 확정, matchEnd=2

결과: 매칭 범위 row 0~2 (최장 매칭)
```

### 6.3 대안선택 Lexical Order: `(A | B) C`

```
패턴: (A | B) C
elements: [0:#ALT, 1:A, 2:B, 3:#END, 4:C, 5:#FIN]

입력 데이터 (row 0에서 A, B 둘 다 true):
┌─────┬───┬───┬───┐
│ row │ A │ B │ C │
├─────┼───┼───┼───┤
│  0  │ T │ T │ F │
│  1  │ F │ F │ T │
└─────┴───┴───┴───┘

실행 과정:

[Row 0] A=T, B=T (둘 다 매칭)
  MatchContext 1 (matchStart: 0)
    ├─ MatchState 1: elementIndex=3 (A 경로, #END 도달)
    └─ MatchState 2: elementIndex=3 (B 경로, #END 도달)

  → 동일 상태 (elementIndex, counts 동일) → Merge
  → paths: [[A], [B]]

[Row 1] C=T
  MatchContext 1 (matchStart: 0)
    └─ MatchState 1: elementIndex=5 (#FIN), paths=[[A,C], [B,C]]

결과: 매칭 범위 row 0~1
  - CLASSIFIER: 첫 번째 경로 [A,C] 반환 (Lexical Order)
  - 내부적으로 두 경로 모두 보존
```

Lexical Order 규칙:
- 대안선택에서 여러 대안이 동시에 매칭되면 모두 추적
- 동일 상태로 Merge되어도 paths는 병합 보존
- CLASSIFIER 조회 시 첫 번째 경로 (왼쪽 우선) 반환

### 6.4 Lexical Order 심화: `A+ (B|A')+`

```
패턴: A+ ( B | A' )+
  - A와 A'는 동일 DEFINE 조건, 다른 패턴 위치
  - A: var_index=0 (A+)
  - A': var_index=0 (B|A' 대안)

elements: [0:A+, 1:#ALT, 2:B, 3:A', 4:#END, 5:#FIN]

┌─────┬───────────┬───────┬─────┬─────┬──────┬──────┐
│ idx │ var_index │ depth │ min │ max │ next │ jump │
├─────┼───────────┼───────┼─────┼─────┼──────┼──────┤
│  0  │   0 (A)   │   0   │  1  │  ∞  │   1  │  -1  │  ← A+
│  1  │    -1     │   0   │  1  │  ∞  │   2  │  -1  │  ← #ALT (그룹 반복)
│  2  │   1 (B)   │   1   │  1  │  1  │   4  │   3  │  ← B (jump→A')
│  3  │   0 (A')  │   1   │  1  │  1  │   4  │  -1  │  ← A' (대안)
│  4  │    -2     │   0   │  1  │  ∞  │   5  │   1  │  ← #END
│  5  │    -3     │   0   │  1  │  1  │  -1  │  -1  │  ← #FIN
└─────┴───────────┴───────┴─────┴─────┴──────┴──────┘

입력 데이터:
┌─────┬───┬───┐
│ row │ A │ B │
├─────┼───┼───┤
│  0  │ T │ T │
│  1  │ T │ T │
│  2  │ T │ T │
│  3  │ F │ F │
└─────┴───┴───┘

실행 과정:

[Row 0] A=T, B=T
  A+ 진입 (min 미충족 → (B|A')+ 진입 불가)

  MatchContext 1 (matchStart: 0)
    └─ MatchState 1: elementIndex=0 (A+), counts=[1]
         paths: [[A]]

[Row 1] A=T, B=T
  ** 새 Context 생성 시도 **
  MatchContext 2 (matchStart: 1)
    └─ MatchState: elementIndex=0 (A+), counts=[1]
         paths: [[A]]

  ** 기존 Context 처리 **
  A+에서 min 충족 → Fork (A+ 계속 vs (B|A')+ 진입)
  (B|A')+에서 B, A' 둘 다 매칭 → 추가 Fork

  MatchContext 1 (matchStart: 0)
    ├─ MatchState 1: elementIndex=0 (A+), counts=[2]
    │    paths: [[A,A]]            ← A+ 반복 (2회)
    ├─ MatchState 2: elementIndex=4 (#END), counts=[0,1]
    │    paths: [[A,B]]            ← A+(1회) → B (Lexical 우선)
    └─ MatchState 3: elementIndex=4 (#END), counts=[0,1]
         paths: [[A,A']]           ← A+(1회) → A'

  → MatchState 2, 3: 동일 상태 (elementIndex=4, counts=[0,1]) → Merge
  → paths 병합: [[A,B], [A,A']]

  Merge 후:
  MatchContext 1 (matchStart: 0)
    ├─ MatchState 1: elementIndex=0 (A+), counts=[2]
    │    paths: [[A,A]]
    └─ MatchState 2: elementIndex=4 (#END), counts=[0,1]
         paths: [[A,B], [A,A']]   ← B 우선 (Lexical Order)

  ** Context 흡수 판정 **
  Context 2의 모든 상태가 Context 1에 포함되는가?
    Context 2 MatchState: idx=0, counts=[1]
    Context 1 MatchState 1: idx=0, counts=[2]  ← 동일 idx, counts[2] >= counts[1]
    → max=∞이므로 흡수 조건 성립
    → Context 2는 Context 1에 흡수, 삭제

  흡수 후: MatchContext 1만 존재

[Row 2] A=T, B=T
  ** 새 Context 생성 시도 **
  MatchContext 3 (matchStart: 2)
    └─ MatchState: elementIndex=0 (A+), counts=[1]
         paths: [[A]]

  ** 기존 Context 처리 **
  MatchState 1 (A+, counts=[2], paths=[[A,A]]):
    → Fork: A+ 계속 vs (B|A')+ 진입
    → (B|A')+에서 B, A' 둘 다 매칭

  MatchState 2 (#END, counts=[0,1], paths=[[A,B],[A,A']]):
    → Fork: 반복 vs 완료
    → 반복: #ALT로 복귀, B, A' 둘 다 매칭

  Fork 결과 (Merge 전):
    from MatchState 1:
    ├─ State A: idx=0, counts=[3], paths=[[A,A,A]]        ← A+ 계속
    ├─ State B: idx=4, counts=[0,1], paths=[[A,A,B]]      ← (B|A')+ 진입, B
    ├─ State C: idx=4, counts=[0,1], paths=[[A,A,A']]     ← (B|A')+ 진입, A'
    │
    from MatchState 2:
    ├─ State D: idx=5 (#FIN), paths=[[A,B],[A,A']]        ← 완료 (짧은 매칭, 폐기 예정)
    ├─ State E: idx=4, counts=[0,2], paths=[[A,B,B],[A,A',B]]    ← 반복, B
    └─ State F: idx=4, counts=[0,2], paths=[[A,B,A'],[A,A',A']]  ← 반복, A'

  Merge 적용:
    - State B, C: 동일 (idx=4, counts=[0,1])
      → paths=[[A,A,B], [A,A,A']]
    - State E, F: 동일 (idx=4, counts=[0,2])
      → paths=[[A,B,B], [A,A',B], [A,B,A'], [A,A',A']]

  짧은 매칭 폐기:
    - State D (#FIN, matchEnd=1): 폐기
    - State E, F (#END, min 충족): 완료 가능, 더 긴 매칭
    → State D는 더 긴 완료 가능 경로 존재 시 즉시 폐기

  Merge 후:
  MatchContext 1 (matchStart: 0)
    ├─ MatchState 1: idx=0, counts=[3]
    │    paths: [[A,A,A]]
    ├─ MatchState 2: idx=4, counts=[0,1]
    │    paths: [[A,A,B], [A,A,A']]
    └─ MatchState 3: idx=4, counts=[0,2]
         paths: [[A,B,B], [A,A',B], [A,B,A'], [A,A',A']]

  ** Context 흡수 판정 **
  Context 3의 모든 상태가 Context 1에 포함되는가?
    Context 3 MatchState: idx=0, counts=[1]
    Context 1 MatchState 1: idx=0, counts=[3]  ← 동일 idx, counts[3] >= counts[1]
    → max=∞이므로 흡수 조건 성립
    → Context 3은 Context 1에 흡수, 삭제

  흡수 후: MatchContext 1만 존재

[Row 3] A=F, B=F (빈 입력)
  MatchState 1: A 불매칭 → 소멸
  MatchState 2: #END에서 min 충족, 완료 전이
    → #FIN 도달, paths=[[A,A,B], [A,A,A']]
  MatchState 3: #END에서 min 충족, 완료 전이
    → #FIN 도달, paths=[[A,B,B], [A,A',B], [A,B,A'], [A,A',A']]

  #FIN 상태들 Merge (동일 상태):
    → paths 병합: [[A,A,B], [A,A,A'], [A,B,B], [A,A',B], [A,B,A'], [A,A',A']]

  구현 상 추가 축약 (A = A'):
    A와 A'는 동일 DEFINE 조건 (동일 var_index)이므로,
    paths의 문자열 표현이 동일하여 추가로 Merge됨:
      - [A,A',B] → [A,A,B] (A'를 A로 기록) → [A,A,B]와 중복
      - [A,A',A'] → [A,A,A'] (A'를 A로 기록) → [A,A,A]와 중복

  결과: matchStart=0, matchEnd=2
    paths: [[A,A,B], [A,A,A], [A,B,B], [A,B,A]]
    CLASSIFIER: [A,A,B] 반환 (첫 번째 = Lexical 우선)
```

**Lexical Order 핵심:**
```
패턴 (B|A')에서:
  - B가 인덱스 2, A'가 인덱스 3
  - 둘 다 매칭되면 paths에 B 경로가 먼저 추가
  - Merge 후에도 순서 유지: [[..B..], [..A'..]]
  - CLASSIFIER는 항상 paths[0] 반환 → B 우선

대안 순서가 결과를 결정:
  - (B|A): B 우선
  - (A|B): A 우선
```

### 6.5 Greedy 폴백: `(A | B C)+`

Greedy 매칭에서 미완료 경로가 실패하면 보존된 완료로 폴백합니다.

```
패턴: (A | B C)+
elements: [0:#ALT, 1:A, 2:B, 3:C, 4:#END, 5:#FIN]

입력 데이터:
┌─────┬───┬───┬───┬───┐
│ row │ A │ B │ C │ D │
├─────┼───┼───┼───┼───┤
│  0  │ T │ F │ F │ F │
│  1  │ F │ T │ F │ F │
│  2  │ F │ F │ F │ T │
└─────┴───┴───┴───┴───┘

실행 과정:

[Row 0] A=T
  - 새 Context 생성 (matchStart: 0)
  - #ALT → A 대안 선택 → A 매칭 → #END
  - #END: count=1, min=1 충족
    - 반복: State(0, #ALT) → 미완료 (더 긴 매칭 시도)
    - 탈출: State(5, #FIN) → 완료(A)
  - Greedy: 미완료 진행 가능 → 완료(A) 보존 (폴백용)
  - 대기: [State(0, [1])]
  - 보존된 완료: [A]

[Row 1] B=T
  - State(0, #ALT): B 대안 선택 → State(2)
  - State(2): B 매칭 → State(3) (C 대기)
  - 새 완료 없음 (BC 미완성)
  - 대기: [State(3, [1])]
  - 보존된 완료: [A] (Row 0에서 보존)

[Row 2] D=T (C 불매칭)
  - State(3): C 기대, D 입력 → 사망
  - 미완료 전멸 → 보존된 완료로 폴백
  - 결과: [A] (2행 전 완료)

결과: 매칭 성공
  - 경로: [A]
  - 범위: Row 0-0
```

**더 긴 시퀀스에서의 폴백:**
```
패턴: (A | B C D E)+
입력: [A], [B], [C], [D], [X]

- Row 0: A 매칭 → 완료(A) 보존
- Row 1: B 매칭 → C 대기
- Row 2: C 매칭 → D 대기
- Row 3: D 매칭 → E 대기
- Row 4: X 입력 → E 기대 실패 → 4행 전 완료(A)로 폴백

결과: Row 0-0, 경로 [A]
```

**Greedy 폴백 원리:**
```
┌────────────────────────────────────────────────────────────────────┐
│  1. 완료 시점에서 더 긴 매칭 시도 가능하면:                          │
│     - 완료 State를 "보존된 완료"로 저장                             │
│     - 미완료 State로 계속 진행                                      │
│                                                                    │
│  2. 미완료 경로가 실패하면:                                         │
│     - 보존된 완료로 폴백                                            │
│     - 몇 행 전의 완료라도 사용 가능                                  │
│                                                                    │
│  3. 보존 기준:                                                      │
│     - 가장 긴 완료 1개만 보존                                       │
│     - 더 긴 완료 발생 시 이전 것 교체                                │
│     - 길이 같으면 Lexical Order 우선                                │
└────────────────────────────────────────────────────────────────────┘
```

**Context 흡수 원리:**
```
흡수 조건:
  - 동일 elementIndex의 상태가 존재
  - max=∞인 경우: 선행 Context.counts >= 후발 Context.counts → 흡수 가능
  - max=유한인 경우: counts 완전 일치 필요 → 실질적으로 흡수 불가
    (다른 row에서 시작한 Context는 counts가 다르므로)

이유 (max=∞인 경우):
  선행 Context가 counts=[3]에 있다면,
  과거에 counts=[1], [2]를 모두 거쳐왔음
  → 후발 Context(counts=[1])의 미래는 선행 Context에 포함됨
  → 후발 Context는 중복, 삭제 가능

효과: O(N)개의 Context → O(1)개로 축소 (max=∞인 경우만)
```

**Shorter Match Discard (짧은 매칭 폐기):**
```
원칙: 더 긴 매칭이 가능하면 짧은 매칭은 폐기

조건 (모두 충족 시 폐기):
  1. completedStates 존재 (현재 완료 가능한 상태)
  2. activeStates 존재 (계속 진행 중인 상태)
  3. canProgressFurther = true (VAR 또는 #ALT에서 진행 가능)
  4. hasPatternMatch = true (입력에 패턴 변수 매칭됨)

예시 (패턴: A+):
  Row 0: A → state at A+, counts=[1], min 충족 → 완료 가능
  Row 1: A →
    - 완료 상태: paths=[[A]] (1회 매칭)
    - 활성 상태: counts=[2], paths=[[A,A]] (계속 진행)
    → 조건 충족: 완료 상태 폐기, 더 긴 매칭 우선

  Row 2: (빈 입력) →
    - 활성 상태만 완료로 전환
    - 결과: paths=[[A,A]] (2회 매칭)

폐기하지 않는 경우:
  - hasPatternMatch = false: EOF나 무관한 입력
    → 짧은 매칭도 유효한 최종 결과일 수 있음
  - canProgressFurther = false: 더 이상 진행 불가
    → 현재 완료가 최선
```

**Chained Skip 처리 (연속 옵션 스킵):**
```
문제: 연속된 옵션 요소가 모두 매칭 실패 시

패턴: ( A | ( B | ( C | D ) ) )
입력: D

elements: [#ALT₀, A, #ALT₁, B, #ALT₂, C, D, #END₂, #END₁, #END₀, #FIN]

일반적 전이:
  #ALT₀ → A 실패 → #ALT₁ (jump)
  #ALT₁ → B 실패 → #ALT₂ (jump)
  #ALT₂ → C 실패 → D (jump)
  D → 매칭! → #END₂ → #END₁ → #END₀ → #FIN

문제 상황 (chained skip):
  state가 #ALT₀에 있고, A, B, C 모두 실패, D만 매칭되는 경우

  단순 구현: #ALT₀ → exit (실패)

  해결: 재귀적 transition

transitionAlt() 내부:
  if (!anyMatched) {
    // 그룹 탈출 시도
    exitState.elementIndex = endElem.next;

    // 핵심: 재귀 호출로 다음 요소 소비 시도
    subResults = this.transition(exitState, trueVars);
    if (subResults.length > 0) {
      results.push(...subResults);  // 연쇄 탈출 성공
    } else {
      results.push(exitState);  // 대기 상태로
    }
  }

효과:
  #ALT₀(A실패) → #ALT₁(B실패) → #ALT₂(C실패) → D(매칭!) → #FIN

  단일 transition() 호출로 연속 스킵 + 최종 매칭까지 처리
```

---

## 7. 복잡도

### 7.1 시간 복잡도

| 연산 | 평균 | 최악 |
|------|------|------|
| 행 처리 | O(S × E) | O(S² × E) |
| 상태 Fork | O(depth) | O(depth) |
| 상태 Merge | O(1) | O(depth) |
| 컨텍스트 흡수 | O(C² × S) | O(C² × S × depth) |

- S: 동시 상태 수
- E: 패턴 요소 수
- C: 컨텍스트 수
- depth: 최대 중첩 깊이

### 7.2 공간 복잡도

| 구성 요소 | 복잡도 |
|-----------|--------|
| Pattern | O(E) |
| MatchState | O(depth + paths) |
| 전체 런타임 | O(C × S × (depth + paths)) |

---

## 8. 향후 확장

### 8.1 MEASURES 절과 실시간 Aggregate

```sql
-- SQL 표준 MEASURES (현재 미구현)
MEASURES
  SUM(B.value) AS b_sum,
  FIRST(A.price) AS a_price
```

**현재 방식: 재스캔**
- matchStart~matchEnd 범위 재스캔
- DEFINE 조건 재적용하여 각 행의 변수 결정
- 집계 함수 계산

**확장 방안: 다중 매처**

ALL ROWS PER MATCH에서 매 행마다 새로운 매칭 시도:
```
row 0: A → MatchContext 1 생성
row 1: A → MatchContext 2 생성, MatchContext 1 진행
row 2: A → MatchContext 3 생성, MatchContext 1,2 진행
...
```

다중 MatchContext가 동시 활성화되며, 최장 매칭 우선 규칙에 따라 흡수됨.

**확장 방안: 다중 스테이트**

분기(Alternation, Quantifier)에서 다중 MatchState 발생:
```
패턴: (A | B) C+
elements: [0:A, 1:B, 2:C+, 3:#FIN]

row 0: A 입력
  MatchContext 1 (matchStart: 0)
    └─ MatchState 1: elementIndex=1 (A 매칭, B 대기)

row 1: C 입력
  MatchContext 1 (matchStart: 0)
    ├─ MatchState 1: elementIndex=2, counts=[1,1] (C 매칭)
    └─ MatchState 2: elementIndex=3 (#FIN, 완료 가능)

row 2: C 입력 (A|B 불일치 → 새 Context 없음)
  MatchContext 1 (matchStart: 0)
    ├─ MatchState 1: elementIndex=2, counts=[1,2] (C 반복)
    ├─ MatchState 2: 폐기 (더 짧은 매칭)
    └─ MatchState 3: elementIndex=3 (#FIN, 완료 가능)

row 3: A 입력 (C 조건 불일치)
  MatchContext 1 완료 (matchStart: 0, matchEnd: 2)
    ├─ MatchState 1: 소멸 (C 불매칭)
    └─ MatchState 3: 확정 (#FIN)
  MatchContext 2 (matchStart: 3)
    └─ MatchState 1: elementIndex=1 (A 매칭)
```

동일 상태 동일 미래 원칙에 따라 1차 Merge 적용.

**확장 방안: 실시간 Aggregate**

전체 구조 (2장 기반 확장):
```
Pattern
  └─ elements[]: {var_index, min, max, next, jump, depth}

Partition: rows[] (RDBMS: 기존 데이터 참조, CEP: 자체 버퍼)
  └─ MatchContext[]: {matchStart, matchEnd}
       └─ MatchState[]: {elementIndex, counts[]}
            └─ summaries[]: {aggregates, paths[]}
```

3단계 계층 구조로 Merge하면서 실시간 집계 가능:

```
┌─────────────────────────────────────────────────────────┐
│ MatchState                                              │
│   elementIndex: 2                                       │
│   counts: [2, 1]                 ← 1차 Merge 기준       │
│                                                         │
│   summaries: [                   ← 2차 Merge 기준       │
│     {                                                   │
│       B_sum: 50, B_count: 2, B_first: 20                │
│       paths: [[A,B,B],[B,C,B]]   ← 3차 Merge 기준       │
│     },                                                  │
│     {                                                   │
│       B_sum: 30, B_count: 1, B_first: 30                │
│       paths: [[A,D,B]]                                  │
│     }                                                   │
│   ]                                                     │
└─────────────────────────────────────────────────────────┘

Merge 규칙:
  원칙: 동일 상태 동일 미래 (NFA 핵심)
  1차: elementIndex + counts[] 동일 → MatchState Merge
  2차: aggregate 값 동일 → summary Merge
  3차: paths 병합 (동일 summary 내에서)

효과:
  - 1차: 상태 수 최소화 (위치 기준 Merge)
  - 2차: summary 수 최소화 (값 기준 Merge)
  - CLASSIFIER: paths에서 조회
  - MEASURES: summary에서 직접 접근 (재스캔 불필요)

Lexical Order 보장:
  summaries[0].paths[0] = 항상 Lexical Order 우선 경로

  원리:
  - summaries 배열: 먼저 도착한 경로의 summary가 앞에 위치
  - paths 배열: 동일 summary 내에서도 도착 순서 유지
  - NFA 전이 순서가 패턴 정의 순서(Lexical Order)를 따름
    → (A|B)에서 A가 인덱스 0, B가 인덱스 1
    → A, B 둘 다 매치 시 A 경로가 먼저 생성/추가

  결과:
  - CLASSIFIER (기본): summaries[0].paths[0] 반환
  - ORDER BY 지정 시: summaries 정렬 후 [0].paths[0] 반환
    → 동일 aggregate 값이면 Lexical Order가 tie-breaker

  예시 (패턴: A+ (B|A)+):
  Row 1에서 A+→B, A+→A' 둘 다 매치:
    paths: [[A,B], [A,A']]  ← B가 먼저 (인덱스 2 < 3)

  최종 결과:
    summaries[0].paths[0] = [A,B]  ← Lexical 우선

최적화: Copy-on-Write
  - summaries, paths는 참조로 공유
  - 참조 > 1: 변경 시 복사
  - 참조 = 1: 직접 수정 (복사 불필요)
```

**같은 aggregate, 다른 경로 예시:**
```
패턴: (A | B) C+
elements: [0:A, 1:B, 2:C+, 3:#FIN]

경로 1: A → C → C → #FIN  (C_sum=50, C_first=10)
경로 2: B → C → C → #FIN  (C_sum=50, C_first=10)

→ 1차: 2개 MatchState → 1개로 Merge (elementIndex=3, counts 동일)
→ 2차: 하나의 summary (aggregate 동일)
→ 3차: paths 2개 ([A,C,C], [B,C,C])
→ MEASURES 동일, CLASSIFIER 다름
```

**RDBMS vs CEP 환경:**
```
CEP (Flink 등):
  스트림 데이터 → 자체 윈도우 버퍼 필요
  MatchContext.rows: [row1, row2, ...]  ← 직접 관리

RDBMS:
  PARTITION BY → 이미 파티션 단위로 rows 존재
  matchStart, matchEnd 인덱스로 기존 데이터 참조
  → 별도 rows 버퍼 불필요
```

**멀티 매칭 구조 (ALL ROWS PER MATCH):**
```
Partition (RDBMS 파티션 데이터 - 공유)
  │
  ├─ MatchContext 1 (matchStart: 0)
  │    └─ states: [...]
  │
  ├─ MatchContext 2 (matchStart: 3)
  │    └─ states: [...]
  │
  └─ MatchContext 3 (matchStart: 7)
       └─ states: [...]
```

**최장 매칭 우선 (Greedy 모드):**

`A+` 패턴에서 A가 연속 입력되면 매 행마다 Context 생성:
```
row 0: A → MatchContext 1 (matchStart: 0, counts=[1])
row 1: A → MatchContext 2 (matchStart: 1, counts=[1])
           MatchContext 1 (counts=[2])
row 2: A → MatchContext 3 (matchStart: 2, counts=[1])
           MatchContext 2 (counts=[2])
           MatchContext 1 (counts=[3])
```

Context 생성 후 흡수:
```
row 1: MatchContext 2 생성 (matchStart: 1)
     → MatchContext 1 진행중 (matchStart: 0)
     → MatchContext 2는 MatchContext 1에 흡수

row 2: MatchContext 3 생성 (matchStart: 2)
     → MatchContext 1 진행중 (matchStart: 0)
     → MatchContext 3은 MatchContext 1에 흡수

결과: 최장 매칭 가능한 Context만 유지
```

흡수 조건:
- 진행중인 Context의 matchStart < 신규 matchStart

**Path 최적화: 청크 트리 + 해시 테이블**

고정 크기 청크(크기=2)와 해시 테이블로 경로 공유 극대화:

```
Hash Key: (parent_chunk, [value, _])
  - parent_chunk: 부모 청크 (첫 청크면 NULL)
  - value: 현재 값
  - RC: Reference Count (공유 경로 수)
```

**예제: 3라운드 실행**

```
ROUND 1: A, B, B 입력

Hash Table:
┌──────────────────────────────────────┐
│ Chunk₁ (NULL, [A,_])    RC:1         │
│ Chunk₂ (NULL, [B,_])    RC:2         │
└──────────────────────────────────────┘

Active Paths: 3
  - Path 1:   [A]  → Chunk₁
  - Path 2,3: [B]  → Chunk₂ (공유)

Chunk Tree:
  Chunk₁[A,_]    Chunk₂[B,_]
     RC:1           RC:2
       ↑            ↑  ↑
      P1           P2  P3
```

```
ROUND 2: A에 A,C,C / B에 D 입력

Hash Table:
┌──────────────────────────────────────┐
│ Chunk₁ (NULL, [A,_])    RC:0 Freed   │
│ Chunk₂ (NULL, [B,_])    RC:0 Freed   │
│ Chunk₃ (NULL, [A,A])    RC:1         │
│ Chunk₄ (NULL, [A,C])    RC:2         │
│ Chunk₅ (NULL, [B,D])    RC:2         │
└──────────────────────────────────────┘

Active Paths: 5
  - Path 1:   [A,A]  → Chunk₃
  - Path 3,4: [A,C]  → Chunk₄ (공유)
  - Path 2,5: [B,D]  → Chunk₅ (공유)

Chunk Tree:
  Chunk₃[A,A]   Chunk₄[A,C]   Chunk₅[B,D]
     RC:1          RC:2          RC:2
       ↑           ↑  ↑          ↑  ↑
      P1          P3  P4        P2  P5
```

```
ROUND 3: AA에 A,D / AC에 A,C / BD에 E,E 입력

Hash Table:
┌──────────────────────────────────────┐
│ Chunk₃ (NULL, [A,A])     RC:2        │
│ Chunk₄ (NULL, [A,C])     RC:2        │
│ Chunk₅ (NULL, [B,D])     RC:1        │
│ Chunk₁ (Chunk₃, [A,_])   RC:1  Reuse │
│ Chunk₂ (Chunk₃, [D,_])   RC:1  Reuse │
│ Chunk₆ (Chunk₄, [A,_])   RC:2        │
│ Chunk₇ (Chunk₄, [C,_])   RC:2        │
│ Chunk₈ (Chunk₅, [E,_])   RC:4        │
└──────────────────────────────────────┘

Active Paths: 10
  - No Path:     [A,A]    → Chunk₃ (중간 노드)
  - No Path:     [A,C]    → Chunk₄ (중간 노드)
  - No Path:     [B,D]    → Chunk₅ (중간 노드)
  - Path 1:      [A,A,A]  → Chunk₃ → Chunk₁
  - Path 6:      [A,A,D]  → Chunk₃ → Chunk₂
  - Path 3,4:    [A,C,A]  → Chunk₄ → Chunk₆ (공유)
  - Path 7,8:    [A,C,C]  → Chunk₄ → Chunk₇ (공유)
  - Path 2,5,9,10: [B,D,E] → Chunk₅ → Chunk₈ (공유)

Chunk Tree:
      Chunk₃[A,A]         Chunk₄[A,C]        Chunk₅[B,D]
         RC:2                RC:2               RC:1
        ↙    ↘              ↙    ↘                ↓
  Chunk₁    Chunk₂    Chunk₆    Chunk₇          Chunk₈
   [A,_]     [D,_]     [A,_]     [C,_]           [E,_]
   RC:1      RC:1      RC:2      RC:2            RC:4
     ↑         ↑       ↑  ↑      ↑  ↑            ↑↑↑↑
    P1        P6      P3 P4     P7 P8         P2,P5,P9,P10

Summary:
  Total Chunks: 8 (10개 경로를 8개 청크로 표현)
  Reused: Chunk₁, Chunk₂ (FreeList에서 재활용)
  최대 공유: Chunk₈ RC:4 (4개 경로가 단일 청크 공유)
```

**동작 원리:**
```
값 추가 시:
  1. hash(prev_chunk, [new_value, _]) 조회
  2. 존재하면: RC 증가, 기존 청크 재사용
  3. 없으면: 새 청크 생성, 해시 테이블 등록

Fork 시:
  - 부모 청크 동일 + 새 값 동일 → 자동 공유
  - RC만 증가, 메모리 할당 없음

GC:
  - RC=0이 되면 청크 해제
  - 부모 청크의 RC도 감소 (재귀적)
```

**장점:**
- 메모리 효율: 동일 경로 자동 공유 (10경로 → 8청크)
- Fork 비용 O(1): RC 증가만으로 분기
- 고정 크기 메모리 풀 사용 가능

**단점:**
- 전체 경로 조회 시 트리 역순회 필요
- 해시 테이블 오버헤드

**DEFINE에서 Aggregate 조건:**

SQL 표준에서 MEASURES는 결과 출력용이지만, 구현상 불가능한 것은 아님.
CEP에서는 DEFINE에서 aggregate 조건이 일반적:
```sql
DEFINE A AS SUM(A.price) > 1000  -- 누적 합 조건
```

동작:
```
row 1: A (price=300) → sum=300, 미충족 → 계속
row 2: A (price=400) → sum=700, 미충족 → 계속
row 3: A (price=500) → sum=1200, 충족 → 매칭
```

CEP (Flink, Esper 등)에서는 스트림 특성상 누적 조건이 빈번:
- 일정 금액 초과 시 알림
- N건 이상 누적 시 트리거
- 윈도우 내 평균 조건

→ summary의 aggregate 값이 상태 전이 조건으로 사용됨

**Aggregate 증분 계산:**
```
증분 저장: SUM, COUNT, FIRST, LAST, MIN, MAX (O(1))
중간 평가: AVG = SUM / COUNT (DEFINE에서 사용 시)
```
→ AVG를 DEFINE 조건에서 쓰려면 매 평가마다 나눗셈 필요 (기존 PG 미고려 가능성)

### 8.2 RELUCTANT 모드

현재는 Greedy (최장 매칭)만 지원. RELUCTANT (최단 매칭) 확장 예정.

### 8.3 PERMUTE

순서 무관 매칭. 확장 예정.

### 8.4 안전 제한 (구현 예정)

| 제한 | 기본값 | 설명 |
|------|--------|------|
| MAX_CONCURRENT_STATES | 1,000 | 동시 상태 수 |
| MAX_CONCURRENT_CONTEXTS | 10,000 | 동시 컨텍스트 수 |
| MAX_PATTERN_ELEMENTS | 100 | 패턴 요소 수 |
| MAX_PATTERN_DEPTH | 10 | 최대 중첩 깊이 |

---

## 부록 A: 구현 파일

| 파일 | 설명 |
|------|------|
| `parser.js` | 패턴 파서 (토크나이저, AST, 최적화, 평탄화) |
| `nfa.js` | NFA 런타임 (MatchState, MatchContext, NFAExecutor) |
| `matcher.html` | 브라우저 UI (시각화) |
| `test.js` | 테스트 스위트 (26개 테스트 케이스) |
