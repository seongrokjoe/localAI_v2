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
  "companyCodeAI.serverUrl": "http://internal-llm-server:8000/v1",
  "companyCodeAI.model": "internal-model",
  "companyCodeAI.maxContextTokens": 200000,
  "companyCodeAI.maxOutputTokens": 60000
}
```

서버에 bearer token이 필요하면 명령 팔레트에서 `Company Code AI: 인증 토큰 설정`을 실행합니다.

## Codex 스타일 작업 흐름

VS Code에서 Git 리포지터리 또는 솔루션의 최상위 루트 폴더를 엽니다. 하위 프로젝트 폴더만 열면 그 밖의 형제 프로젝트 파일은 보안상 읽거나 수정할 수 없습니다. 프로젝트가 크면 루트 폴더를 연 상태에서 `Company Code AI: 활성 스코프 설정`으로 작업할 솔루션, 프로젝트, 폴더를 좁히는 것이 좋습니다. `전체 워크스페이스 사용 (스코프 없음)`은 활성 스코프 없이 전체 폴더를 사용한다는 뜻입니다. 목록에 원하는 하위 폴더나 프로젝트 파일이 없으면 `폴더/파일 직접 선택...`을 사용합니다.

모드:

- `PlanMode`: 리뷰, 설명, 계획만 수행합니다. 파일 수정은 비활성화됩니다.
- `ImplementMode`: 구현 응답을 받은 뒤 편집 가능한 AI 작업본을 만들 수 있습니다. 원본 파일은 작업본의 conflict를 모두 해결하고 diff를 검토한 뒤 승인해야만 변경됩니다.

기본 단축키:

- `Ctrl+Alt+P`: PlanMode로 전환
- `Ctrl+Alt+I`: ImplementMode로 전환
- `Ctrl+Alt+L`: 컨텍스트 비우기

PlanMode 응답에는 계획 구현, 계획 다듬기, 버리기, 기억하기, 컨텍스트 비우기 버튼이 표시됩니다. 계획 구현을 누르면 내부 구현 프롬프트 전체를 채팅에 노출하지 않고, 선택한 계획 구현을 시작한다는 짧은 메시지만 표시합니다. 확장은 세션 메모리와 AI가 적용한 변경 스냅샷을 워크스페이스의 `.company-code-ai/` 아래에 저장합니다.

LLM 요청이 실행되는 동안 채팅 본문에는 `실행 중 00:00` 형식의 경과 시간이 표시됩니다. 모델 응답 텍스트는 토큰 단위로 화면에 갱신하지 않고, 응답이 끝난 뒤 한 번에 표시합니다. 사용자가 이전 대화를 보기 위해 위로 스크롤하면 경과 시간이나 단계가 갱신돼도 자동으로 맨 아래로 이동하지 않으며, 다시 하단으로 이동한 뒤에는 새 메시지를 따라갑니다.

서버, 토큰, 파일, 초기화, 비우기와 계획/구현 버튼은 채팅 상단에 고정됩니다. 대화가 길어지면 가운데 메시지 영역만 스크롤되며 하단 입력창도 계속 표시됩니다.

ImplementMode 응답이 끝나면 `AI 작업본 만들기` 버튼이 표시됩니다. 버튼을 누르면 파일과 수정 범위를 선택합니다. 요청 전에 추가한 선택 영역, 현재 편집기 선택 영역, VS Code가 제공하는 함수·클래스·메서드, 직접 선택, 작은 파일의 전체 범위를 사용할 수 있습니다. 범위가 모호하면 확장이 임의로 추측하지 않습니다.

확장은 선택 범위별 수정 완료 코드를 사내 LLM에 요청하고, 원본 파일 전체를 복제한 로컬 작업본에 Git conflict 형태로 원본과 AI 제안을 함께 넣습니다. conflict 위의 CodeLens에서 `원본 사용`, `AI 제안 사용`, `둘 다 사용`, `두 내용 비교`를 선택하거나 작업본을 일반 코드처럼 직접 편집하고 복사·붙여넣을 수 있습니다. 작업본은 VS Code의 로컬 workspace storage에 저장되므로 Git 저장소에는 나타나지 않습니다.

모든 conflict를 해결하면 `완성본 검토`로 원본 스냅샷과 작업본의 전체 diff를 엽니다. 검토 이후에만 `원본에 저장` 버튼이 표시됩니다. 작업본 생성 후 원본이 바뀌었거나 conflict marker가 남아 있으면 저장을 차단합니다. 최종 저장은 기존 인코딩, BOM, 줄바꿈을 유지하고 디스크 바이트를 다시 검증합니다. 작업본을 diff 검토 이후 다시 편집하면 검토 상태가 취소되어 diff를 다시 확인해야 합니다.

native tool calling을 지원하는 서버에는 구조화된 `submitRegionReplacement` 요청을 사용하고, 지원하지 않는 서버에서는 단일 코드 블록 또는 일반 응답을 AI 후보로 사용합니다. LLM 응답의 경로, 줄 번호, 앵커, `originalText`는 실제 적용 위치로 사용하지 않습니다. Makefile Tools 등 다른 VS Code 확장은 필수 의존성이 아닙니다.

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
