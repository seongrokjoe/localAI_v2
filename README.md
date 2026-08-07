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
- `ImplementMode`: 구현이 가능하지만, 파일 변경은 VS Code 승인 팝업을 거친 뒤에만 적용됩니다.

기본 단축키:

- `Ctrl+Alt+P`: PlanMode로 전환
- `Ctrl+Alt+I`: ImplementMode로 전환
- `Ctrl+Alt+L`: 컨텍스트 비우기

PlanMode 응답에는 계획 구현, 계획 다듬기, 버리기, 기억하기, 컨텍스트 비우기 버튼이 표시됩니다. 계획 구현을 누르면 내부 구현 프롬프트 전체를 채팅에 노출하지 않고, 선택한 계획 구현을 시작한다는 짧은 메시지만 표시합니다. 확장은 세션 메모리와 AI가 적용한 변경 스냅샷을 워크스페이스의 `.company-code-ai/` 아래에 저장합니다.

LLM 요청이 실행되는 동안 채팅 본문에는 `실행 중 00:00` 형식의 경과 시간이 표시됩니다. 모델 응답 텍스트는 토큰 단위로 화면에 갱신하지 않고, 응답이 끝난 뒤 한 번에 표시합니다.

ImplementMode 응답이 끝나면 확장은 먼저 수정 대상 파일을 확정하고, 해당 파일의 현재 원문을 워크스페이스에서 직접 다시 읽습니다. 파일별 패치 JSON의 필드와 `originalText`를 검증하고, 형식 누락이나 원문 불일치가 있으면 오류를 포함해 최대 3회 자동 재시도합니다. 이 검증이 끝난 경우에만 `예, 파일에 적용` / `아니오, 버리기` 버튼이 표시됩니다. `예, 파일에 적용`을 누른 뒤에는 LLM을 다시 호출하지 않고 이미 검증된 패치를 실제 파일에 적용합니다. 실제 디스크 바이트까지 검증된 경우에만 `실제 파일 변경 완료`가 표시되고 버튼이 사라집니다.

기존 파일 변경은 `originalText`와 `replacementText` 기반으로 적용하며, VS Code가 감지한 파일 인코딩과 줄바꿈 스타일을 기준으로 변경 범위를 최소화합니다. 사내 LLM이 `file/oldText/newText` 같은 호환 필드명을 반환해도 정규화하며, 필수 필드가 없으면 조용히 버리지 않고 재시도 사유로 사용합니다. VS Code 저장 후 디스크 내용을 다시 읽어 검증하고, 내용이 반영되지 않았으면 같은 인코딩과 BOM으로 직접 저장을 재시도합니다. 새 파일 생성에만 전체 파일 내용 적용을 사용합니다. 마지막 적용 경로와 저장 단계는 `Company Code AI: 마지막 패치 진단 보기`에서 확인할 수 있습니다.

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
