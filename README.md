# omp-codex-usage

omp 하단 상태라인에 Codex 구독 플랜의 **사용한 비율**을 표시하는 플러그인입니다.
`omp-opencode-go-usage`와 같은 표시 방식·갱신 주기를 사용합니다.

```text
… · CO 5h 22% | Wk 19%
```

| 표시 | 의미 |
| --- | --- |
| `5h` | 5시간 사용 한도 중 사용한 비율 |
| `Wk` | 주간 사용 한도 중 사용한 비율 |
| `!` | 해당 한도 소진 또는 API의 기본 사용량 그룹 제한 판정 |
| `?` | 최근 조회 실패. 마지막으로 확인된 값이며 오래된 정보일 수 있음 |

남은 비율이 아니라 **사용률**입니다. 한도 초기화 시 값이 내려갑니다.
각 항목은 ` | `로 묶고, 다른 플러그인과의 구분자 ` · `는 omp가 붙입니다.
그룹 앞의 `CO`는 Codex를 뜻하며, 사용량이 숨겨지면 함께 숨겨집니다.
`5h 100%!?`처럼 제한과 조회 실패 표시가 함께 붙을 수 있습니다.

Codex의 기본 `rate_limit`에 있는 한도만 표시합니다. 월간 한도를 만들어내지 않으며,
주간 한도만 제공되는 플랜에서는 `CO Wk …%`만 표시합니다. 태그는 응답의 실제 기간에서
계산하므로 주간 한도가 `primary_window`에 와도 `5h`로 잘못 표시하지 않습니다.
추가 모델별 한도(Spark 등), 코드 리뷰 한도, 유료 크레딧 및 저장된 리셋 횟수는
이 기본 플랜 사용량 미터에 합산하지 않습니다.

Codex는 각 기간별 제한 여부가 아니라 그룹 전체의 `allowed` / `limit_reached`를
제공합니다. 100%인 기간에는 `!`를 붙이고, 100%인 기간 없이 그룹이 제한되면 모든
표시 항목에 `!`를 붙입니다. **유료 크레딧으로 계속 사용할 수 있는지는 뜻하지 않습니다.**

## 요구 사항과 인증

- omp 18.x의 `ctx.ui.setStatus`, `ctx.modelRegistry`, `ctx.setInterval` API.
  실제 실행 검증 버전: **18.11.3**.
- omp의 **`openai-codex` OAuth 로그인**. 이미 로그인되어 있으면 추가 인증 불필요.
- 테스트 실행 시 Node.js 24 이상. 플러그인 실행에는 별도 Node.js나 npm 의존성 불필요.

로그인이 없다면 omp에서 다음 명령을 실행합니다.

```text
/login openai-codex
```

omp의 OpenAI OAuth 절차를 사용하며, 플러그인이 별도의 OAuth 앱·토큰 저장소·콜백
서버를 만들지 않습니다. 매 갱신 시
`ctx.modelRegistry.getApiKeyForProvider("openai-codex", sessionId)`로 인증을 얻으므로
활성 프로필, 세션별 계정 선택 및 만료 토큰 갱신은 omp가 처리합니다.
여러 계정이 있는 경우 전체 계정 합계가 아니라 **omp가 해당 세션에 선택한 계정**입니다.

`OPENAI_API_KEY`는 OpenAI Platform API용이므로 Codex 구독 사용량 인증의 대체재로
사용하지 않습니다. 자격증명을 얻지 못하면 항목을 숨기고 사용량 요청을 하지 않습니다.
로그인 후 다음 90초 갱신이나 턴 종료 시 자동으로 표시됩니다.

## 설치

GitHub에서 설치합니다.

```sh
omp plugin install github:pawprint0706/omp-codex-usage
omp plugin list
```

또는 로컬 프로젝트 경로로 설치합니다.

```sh
omp plugin install "/path/to/omp-codex-usage"
omp plugin list
```

설치 후 omp를 다시 시작합니다. 또는 `extensions/codex-usage.ts`를
`~/.omp/agent/extensions/`에 복사할 수 있습니다. 두 방법을 동시에 쓰지 마세요.

설치 전 일회성 실행:

```sh
omp --extension ./extensions/codex-usage.ts
```

## 상태라인 설정

기존 설정이 `statusLine.preset: custom`이고 `leftSegments` 또는 `rightSegments`에
`status`가 있으면 추가 설정이 필요 없습니다. 그렇지 않으면
[`statusline.yml`](./statusline.yml)을 `~/.omp/agent/config.yml`에 **병합**합니다.
이름 있는 프로필은 `~/.omp/profiles/<profile>/agent/config.yml`을 사용합니다.

기존 세그먼트 목록·테마·`segmentOptions`를 덮어쓰지 말고 `status`만 추가하세요.
`preset: custom`이어야 명시한 세그먼트 목록이 적용됩니다.
OpenCode Go 플러그인과 함께 쓰면 두 미터가 각각 ` · `로 구분됩니다.

## 갱신과 오류 처리

| 시점 | 동작 |
| --- | --- |
| `session_start` | 최초 조회를 기다린 뒤 관리형 타이머 시작 |
| `turn_end` | 턴을 차단하지 않는 비동기 조회 |
| 90초마다 | 다른 클라이언트에서 사용한 양과 한도 초기화 반영 |

- 진행 중인 조회는 재사용합니다(single-flight).
- HTTP 요청 제한 시간은 10초입니다. 인증 조회·토큰 갱신은 omp가 관리합니다.
- 조회 실패 시 같은 계정의 이전 값을 `?`와 함께 유지합니다.
- 최초 조회부터 실패하면 항목을 숨기고 실패 구간당 경고를 한 번 표시합니다.
- 정상 조회 후 경고 상태가 초기화됩니다. 오류 종류는 `codex-usage: …`로 기록하며,
  토큰·계정 ID·서버 응답 본문은 기록하지 않습니다.
- 계정이 바뀌거나 인증이 없어지면 이전 계정의 캐시를 지웁니다.
- 메인 세션에서만 조회합니다. 서브에이전트에서는 요청·표시하지 않습니다.
- 세션 종료 시 캐시를 지우고 omp가 관리형 타이머를 정리합니다.
- 응답의 사용률(0–100), 기간, 리셋 시각, 제한 판정을 확인합니다.
  제공된 기간 중 하나라도 잘못되면 일부 숫자만 표시하지 않고 전체 조회를 실패 처리합니다.

## 데이터 출처

`GET https://chatgpt.com/backend-api/wham/usage`에 omp가 제공한 OAuth bearer와
토큰의 `chatgpt_account_id`를 `ChatGPT-Account-Id` 헤더로 전송합니다.
리디렉션은 허용하지 않으며 모델용 프록시 URL로 인증을 보내지 않습니다.

이 엔드포인트는 omp도 사용하는 ChatGPT 내부 API로, 공개 OpenAI Platform API의
안정성 계약이 있는 것은 아닙니다. 응답 형식 변경 시 플러그인 수정이 필요할 수 있습니다.

참조한 공식 omp 소스:

- [Codex 사용량 조회](https://github.com/can1357/oh-my-pi/blob/v18.11.3/packages/ai/src/usage/openai-codex.ts)
- [Codex OAuth](https://github.com/can1357/oh-my-pi/blob/v18.11.3/packages/ai/src/registry/oauth/openai-codex.ts)
- [ModelRegistry 인증 조회](https://github.com/can1357/oh-my-pi/blob/v18.11.3/packages/coding-agent/src/config/model-registry.ts)

## 검증

```sh
npm test
```

네트워크·실제 인증 없이 사용률 표시, 주간 전용 플랜, 제한 판정, 잘못된 응답,
오류 후 복구, 로그인·로그아웃·계정 전환, single-flight, 서브에이전트 제외,
세션 종료 중인 요청을 검증합니다.

실제 인증 및 TUI 검증은 별도로 omp 18.11.3에서 수행했습니다. 기존 Codex 로그인으로
API의 HTTP 200 응답을 확인했고, `CO` 접두어 적용 후 실제 상태라인에서
`CO 5h 29% | Wk 20%` 표시를 확인했습니다. 이는 검증 당시의 값이며 고정값이 아닙니다.

## 제거

```sh
omp plugin uninstall omp-codex-usage
```

## 라이선스

MIT. [`LICENSE`](./LICENSE) 참조.
