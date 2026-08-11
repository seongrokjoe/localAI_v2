# Company Code AI

사내 Chat Completions 호환 LLM 서버에 연결해서 VS Code 안에서 코드 리뷰, 계획 수립, 리팩토링, 수정 제안을 수행하는 코드베이스 도우미입니다.

## 개발 PC에서 빌드

```bash
npm install
npm run compile
npm run check:endpoints
```

VS Code의 Extension Development Host로 실행해서 개발 중인 확장을 확인할 수 있습니다.

## Node.js 없는 PC용 패키징

개발 PC에서 VSIX를 생성합니다.

```bash
npm install
npm run package:vsix
```

회사 PC에서는 VS Code에서 `release/company-code-ai.vsix`를 설치합니다.

1. Extensions 열기
2. `...` 선택
3. `Install from VSIX...` 선택
4. `company-code-ai.vsix` 선택
5. 설치 후 `Developer: Reload Window` 실행

일반 사용에는 회사 PC에 Node.js 또는 npm이 필요하지 않습니다.

설치 후 VS Code 설정에서 사내 서버 정보를 입력합니다.

```json
{
  "companyCodeAI.activeServerProfile": "existing",
  "companyCodeAI.serverProfiles": {
    "existing": {
      "serverUrl": "http://old-internal-llm:8000/v1",
      "model": "old-model",
      "toolCallMode": "auto",
      "maxContextTokens": 200000,
      "maxOutputTokens": 60000,
      "requestTimeoutMs": 120000
    },
    "new": {
      "serverUrl": "http://new-internal-llm:8000/v1",
      "model": "new-model",
      "toolCallMode": "required",
      "maxContextTokens": 200000,
      "maxOutputTokens": 60000,
      "requestTimeoutMs": 120000
    }
  }
}
```

채팅 상단의 서버 버튼 또는 명령 팔레트의 `Company Code AI: LLM 서버 선택`에서 `기존 서버`와 `변경 서버`를 재시작 없이 전환할 수 있습니다. 기존 단일 `serverUrl`/`model` 설정만 있으면 처음 프로필을 열 때 어느 서버 프로필로 가져올지 선택합니다.

Tool Calling 방식은 서버 프로필마다 설정합니다.

`maxContextTokens`는 모델의 입력과 출력을 합한 전체 컨텍스트 길이입니다. Extension은 여기서
`maxOutputTokens`와 안전 여유를 제외한 범위만 입력에 사용하며, 큰 구현 대상은 여러 요청으로
자동 분할합니다. ImplementMode에서는 명시적으로 선택한 파일만 수정 대상으로 사용하고 직접
참조한 로컬 include/import 파일은 제한된 읽기 전용 참고자료로만 전송합니다.

- `auto`: native tools와 `tool_choice="auto"`를 전송하고 텍스트 JSON fallback도 허용합니다. vLLM 서버에 `--enable-auto-tool-choice`와 모델별 `--tool-call-parser`가 필요합니다.
- `native`: `auto`와 같은 native 요청을 보내되 native `tool_calls`만 처리합니다.
- `required`: `tool_choice="required"`와 내부 최종 응답 도구를 사용합니다. vLLM structured outputs 기반 서버용입니다.
- `json`: native tools를 전송하지 않고 텍스트 JSON envelope만 처리합니다.
- `disabled`: 워크스페이스 도구를 전송하지 않습니다.

인증 토큰은 두 프로필이 공통으로 사용하며 VS Code SecretStorage에 저장됩니다.

서버에 bearer token이 필요하면 명령 팔레트에서 `Company Code AI: 인증 토큰 설정`을 실행합니다.

## Codex 스타일 작업 흐름

VS Code에서 Git 리포지터리 또는 솔루션의 최상위 루트 폴더를 엽니다. 하위 프로젝트 폴더만 열면 그 밖의 형제 프로젝트 파일은 보안상 읽거나 수정할 수 없습니다. 프로젝트가 크면 루트 폴더를 연 상태에서 `Company Code AI: 활성 스코프 설정`으로 작업할 솔루션, 프로젝트, 폴더를 좁히는 것이 좋습니다. `전체 워크스페이스 사용 (스코프 없음)`은 활성 스코프 없이 전체 폴더를 사용한다는 뜻입니다. 목록에 원하는 하위 폴더나 프로젝트 파일이 없으면 `폴더/파일 직접 선택...`을 사용합니다.

모드:

- `PlanMode`: 리뷰, 설명, 계획만 수행합니다. 파일 수정은 비활성화됩니다.
- `ImplementMode`: 구현 응답의 코드 블록을 좌우 변경 작업대에서 매핑하고 파일별로 저장할 수 있습니다.

기본 단축키:

- `Ctrl+Alt+P`: PlanMode로 전환
- `Ctrl+Alt+I`: ImplementMode로 전환
- `Ctrl+Alt+L`: 컨텍스트 비우기

PlanMode 응답에는 계획 구현, 계획 다듬기, 버리기, 기억하기, 컨텍스트 비우기 버튼이 표시됩니다. 계획 구현을 누르면 내부 구현 프롬프트 전체를 채팅에 노출하지 않고, 선택한 계획 구현을 시작한다는 짧은 메시지만 표시합니다. 확장은 세션 메모리와 AI가 적용한 변경 스냅샷을 워크스페이스의 `.company-code-ai/` 아래에 저장합니다.

LLM 요청이 실행되는 동안 채팅 본문에는 `실행 중 00:00` 형식의 경과 시간이 표시됩니다. 모델 응답 텍스트는 토큰 단위로 화면에 갱신하지 않고, 응답이 끝난 뒤 한 번에 표시합니다. 사용자가 이전 대화를 보기 위해 위로 스크롤하면 경과 시간이나 단계가 갱신돼도 자동으로 맨 아래로 이동하지 않으며, 다시 하단으로 이동한 뒤에는 새 메시지를 따라갑니다.

서버, 토큰, 파일, 초기화, 비우기와 계획/구현 버튼은 채팅 상단에 고정됩니다. 대화가 길어지면 가운데 메시지 영역만 스크롤되며 하단 입력창도 계속 표시됩니다.

ImplementMode는 `파일` 또는 `선택 영역` 컨텍스트에 추가된 파일의 전체 원문을 전역 줄 번호와 스냅샷 해시와 함께 LLM에 전달합니다. 활성 스코프만 설정했다고 모든 하위 파일을 구현 요청에 자동 첨부하지는 않습니다. 구현 컨텍스트가 비어 있으면 요청 직전에 여러 파일을 선택하는 창이 열립니다. 저장되지 않은 대상 파일은 먼저 저장해야 합니다.

한 요청의 입력은 약 150k 토큰 이하로 구성합니다. 여러 파일은 여러 요청으로 나누고, 단독으로 큰 파일은 전역 줄 번호를 유지한 채 겹치는 구간으로 나눕니다. LLM은 파일 ID, 스냅샷, 원본 시작/종료 줄, 변경 연산과 실제 코드 플래그를 반환합니다. 확장은 플래그 안의 코드만 추출하며 `originalText` 문자열 검색, 시작/종료 앵커, Markdown 코드 블록 추측을 자동 매핑에 사용하지 않습니다.

유효한 변경 응답이 있으면 편집기 메인 영역에 변경 작업대가 자동으로 열립니다. 왼쪽 패널에는 실제 AI 코드, 설명, 원본 줄 범위와 체크박스가 표시되고, 오른쪽에는 요청 당시 원본을 복제한 로컬 작업 파일이 VS Code 네이티브 편집기로 열립니다. 이 과정에서 LLM 서버를 다시 호출하지 않습니다.

체크박스를 선택하면 매핑된 오른쪽 범위가 AI 코드로 교체됩니다. 경로나 범위를 자동으로 확정하지 못한 블록은 `대상 파일 선택`으로 파일을 연 뒤 오른쪽 편집기에서 범위를 선택하고 `선택 범위 연결`을 누릅니다. `복사` 버튼이나 일반 복사·붙여넣기로 작업 파일을 직접 편집할 수도 있습니다. 작업 파일은 VS Code의 로컬 extension storage에 저장되므로 Git 저장소에는 나타나지 않습니다.

왼쪽 패널의 `변경 비교`는 해당 파일의 원본 스냅샷과 오른쪽 작업 파일의 diff를 엽니다. `이 파일 저장`은 현재 오른쪽 작업 파일 전체를 실제 프로젝트 파일에 즉시 저장합니다. 작업대 생성 이후 원본이 바뀌었거나 저장되지 않은 원본 편집이 있으면 덮어쓰지 않습니다. 저장 시 기존 인코딩, BOM, 줄바꿈을 유지하고 디스크 바이트를 다시 검증합니다.

ImplementMode의 변경 생성 요청에는 LLM 도구 호출 기능을 사용하지 않습니다. 서버가 일반 Chat Completions 요청과 텍스트 응답을 지원하면 동일한 라인 변경 프로토콜을 사용합니다. 응답 형식이나 스냅샷이 맞지 않는 변경은 자동 적용하지 않으며 사용자가 직접 대상 파일과 범위를 연결합니다. Makefile Tools 등 다른 VS Code 확장은 필수 의존성이 아닙니다.

원격 Git 접근 없이 마지막 AI 적용 변경을 검토하려면 `Company Code AI: 마지막 AI 변경 리뷰`를 실행합니다.

## 프로젝트 요약 초기화

대형 솔루션에서는 먼저 `Company Code AI: 프로젝트 요약 초기화`를 실행하거나, 사이드바의 `초기화` 버튼을 누르거나, 채팅 입력창에 `/init`을 입력합니다.

초기화 흐름:

- 로컬 `.sln` 및 프로젝트 파일을 스캔합니다.
- 각 프로젝트를 사내 LLM 요청으로 나누어 요약합니다.
- 프로젝트별 요약을 리포지터리 수준 `SUMMARY.md`로 축약합니다.
- 저장 전에 생성된 markdown을 미리 보여줍니다.
- 중간 캐시는 `.company-code-ai/init/` 아래에 저장합니다.

구조가 크게 바뀐 뒤에는 `/init refresh` 또는 `Company Code AI: 프로젝트 요약 갱신`을 실행합니다. 생성된 파일을 다시 열려면 `/summary` 또는 `Company Code AI: 프로젝트 요약 열기`를 사용합니다. 일반 채팅 요청에는 `SUMMARY.md`가 자동으로 참고 컨텍스트로 포함됩니다.

## 보안 기본값

- 서버 URL은 요청 전마다 검증됩니다.
- 인증 토큰은 VS Code SecretStorage에 저장됩니다.
- 확장은 임의 shell 명령을 실행하지 않습니다.
- 프롬프트와 소스 텍스트는 extension log에 기록하지 않습니다.
- 초기화 캐시와 변경 스냅샷은 열린 워크스페이스의 `.company-code-ai/` 아래에만 저장됩니다.
- 안전한 워크스페이스 도구는 파일 목록 조회, 파일 읽기, 텍스트 검색, Git diff 읽기, 패치 제안, 사용자 승인 후 패치 적용으로 제한됩니다.
