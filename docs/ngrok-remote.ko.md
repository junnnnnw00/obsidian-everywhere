# ngrok로 Remote Vault Bridge 구성하기

[English](ngrok-remote.md) | [한국어](ngrok-remote.ko.md)

이 튜토리얼은 외부 서버에서 실행되는 MCP 클라이언트를 내 로컬 컴퓨터의
Obsidian vault에 연결합니다. 원격 에이전트는 그래프 탐색, 전문·시맨틱 검색,
토큰 예산 기반 컨텍스트 번들, 그리고 사용자가 활성화한 경우 보호된 노트
편집 도구까지 사용할 수 있습니다.

```text
외부 서버의 Claude Code / Codex
              │  HTTPS + Bearer token 기반 MCP
              ▼
        고정 ngrok URL
              │  공유기 inbound port 없이 암호화 tunnel
              ▼
 Obsidian Everywhere HTTP 서버
              │  직접 파일시스템 접근
              ▼
        로컬 Obsidian vault
```

tunnel이 vault를 업로드하거나 동기화하지는 않습니다. Obsidian Everywhere는
계속 vault 옆에서 실행되며 파일을 로컬로 읽고, ngrok은 인증된 MCP 요청만
전달합니다.

## 보안 모델

Bearer token은 해당 HTTP 프로세스가 제공하는 모든 도구의 권한입니다. vault
비밀번호처럼 취급하세요.

- 32바이트 이상의 새 무작위 token을 사용합니다.
- 로컬 HTTP 포트를 인터넷에 직접 열지 말고 ngrok HTTPS URL만 노출합니다.
- 처음에는 read-only로 연결하고, 원격 읽기를 확인한 뒤 쓰기를 켭니다.
- token을 이슈, 채팅, 화면 캡처, shell 기록이나 로그에 붙이지 않습니다.
- 노출되면 즉시 교체합니다.
- 서버가 상수 시간 비교와 인증 실패 rate limit을 적용해도 강한 secret과
  HTTPS는 여전히 필수입니다.
- 단일 사용자 bridge이며 multi-tenant 권한 시스템이 아닙니다.

여러 사용자나 브라우저 기반 공개 connector에는 [배포 가이드](deploy.ko.md)의
OAuth transport를 권장합니다.

## 준비 사항

- vault를 읽을 수 있는 컴퓨터에 Node.js 20.9–26
- [ngrok 계정과 agent](https://ngrok.com/download)
- 고정 ngrok 개발/custom domain. 현재 무료 계정에는 할당된 개발 domain
  하나가 제공되므로 dashboard에서 정확한 hostname을 확인합니다.
- 외부 서버에 Claude Code, Codex 또는 Streamable HTTP MCP client

vault 컴퓨터에서 먼저 확인합니다.

```bash
npx -y obsidian-everywhere doctor "/vault/절대/경로"
test -e "/vault/절대/경로/.obsidian/app.json"
```

두 번째 명령은 권장 mount sentinel을 확인합니다. `.obsidian/app.json`이 없다면
의도한 drive/share가 연결됐을 때만 존재하는 다른 vault-relative 경로를
고르세요.

## 1. MCP Bearer token 생성

```bash
openssl rand -hex 32
```

결과를 password manager에 저장합니다. ngrok authtoken과 MCP bearer token은
서로 다른 자격증명입니다.

- **ngrok authtoken**: 로컬 ngrok agent가 내 ngrok 계정에 endpoint를 생성
- **MCP bearer token**: 원격 MCP client가 vault 도구 사용

둘을 재사용하지 마세요.

## 2. Obsidian Everywhere를 로컬에서 실행

첫 연결은 read-only로 시작합니다.

```bash
export OBSIDIAN_VAULT_PATH="/vault/절대/경로"
export OBSIDIAN_EVERYWHERE_TOKEN="<새-MCP-bearer-token>"
export OBSIDIAN_EVERYWHERE_READONLY=true
export OBSIDIAN_EVERYWHERE_MOUNT_GUARD=true
export OBSIDIAN_EVERYWHERE_MOUNT_SENTINEL=".obsidian/app.json"
export PORT=3737

npx -y --package obsidian-everywhere obsidian-everywhere-http
```

다른 terminal에서 확인합니다.

```bash
curl --fail http://127.0.0.1:3737/healthz
```

정상 응답:

```json
{"ok":true,"vaultState":"healthy","mountGuardEnabled":true}
```

Beta mount guard는 opt-in입니다. 활성화하면:

1. 시작할 때 비어 있거나 sentinel이 없는 mount를 거부하고,
2. 실행 중 mount가 사라지면 기존 인덱스를 보존하며,
3. 인덱스가 stale할 수 있는 동안 모든 쓰기를 차단하고,
4. mount가 돌아오면 filesystem watcher를 다시 만들고 전체 인덱스를 재조정하며,
5. scan 완료 전 mount가 사라지면 index transaction을 rollback합니다.

sentinel이 없으면 최상위 폴더가 비어 있는지만 확인합니다. unmount 뒤 드러난
fallback 디렉터리에도 파일이 있을 수 있으므로 sentinel이 더 안전합니다.

## 3. ngrok 설정

agent를 설치하고 인증합니다.

```bash
ngrok config add-authtoken "<ngrok-authtoken>"
ngrok config check
```

`ngrok config check`가 실제 설정 파일 위치를 출력합니다.

| OS | 기본 위치 |
|---|---|
| macOS | `~/Library/Application Support/ngrok/ngrok.yml` |
| Linux | `~/.config/ngrok/ngrok.yml` |
| Windows | `%LocalAppData%\ngrok\ngrok.yml` |

ngrok Agent config v3 예시:

```yaml
version: "3"

agent:
  authtoken: <ngrok-authtoken>

endpoints:
  - name: obsidian-everywhere
    url: https://할당된-domain.ngrok-free.app
    upstream:
      url: http://127.0.0.1:3737
```

검증하고 endpoint를 실행합니다.

```bash
ngrok config check
ngrok start obsidian-everywhere
```

외부 서버 또는 다른 network에서 확인합니다.

```bash
curl --fail https://할당된-domain.ngrok-free.app/healthz
```

ngrok 무료 tier의 browser 경고 페이지는 programmatic API 요청에는 영향을
주지 않습니다.

## 4. 외부 MCP client 등록

### Claude Code

외부 서버에서:

```bash
claude mcp add --transport http obsidian-everywhere \
  https://할당된-domain.ngrok-free.app/mcp \
  --header "Authorization: Bearer <MCP-bearer-token>"

claude mcp get obsidian-everywhere
```

`Type: http`, `Status: Connected`가 표시되어야 합니다. 출력에는 Authorization
header가 있으므로 가리지 않은 채 공유하면 안 됩니다.

### Codex

```bash
export OBSIDIAN_EVERYWHERE_CLIENT_TOKEN="<MCP-bearer-token>"

codex mcp add obsidian-everywhere \
  --url https://할당된-domain.ngrok-free.app/mcp \
  --bearer-token-env-var OBSIDIAN_EVERYWHERE_CLIENT_TOKEN
```

Codex 또는 ChatGPT Desktop을 실행하는 프로세스에도 환경변수가 전달되어야
합니다.

## 5. 쓰기를 켜기 전에 컨텍스트 확인

새 원격 session에서 다음을 요청합니다.

1. `vault_status` 호출
2. `list_notes(limit=5, recursive=true)` 호출
3. 실제 존재하는 주제 검색
4. 그 주제의 `get_context_bundle` 호출

다음을 확인하세요.

- `vault_status`가 `healthy`
- 노트 수가 vault 컴퓨터의 `doctor` 결과와 일치
- 폴더와 노트가 의도한 vault의 것
- 컨텍스트 번들에 예상한 연결 이웃이 포함

노트가 0개라면 쓰기를 켜지 말고 아래 문제 해결을 확인하세요.

## 6. 원격 쓰기 활성화

로컬 HTTP 프로세스를 중지하고 read-only 환경변수를 제거한 뒤 다시 실행합니다.

```bash
unset OBSIDIAN_EVERYWHERE_READONLY
npx -y --package obsidian-everywhere obsidian-everywhere-http
```

사용자의 명시적 승인을 받고 임시 노트로 테스트합니다.

1. `Remote Bridge Test.md` 생성
2. 원격에서 다시 읽기
3. Obsidian에서 실제 표시 확인
4. 기본 복구 가능한 휴지통 방식으로 삭제

성공한 쓰기는 MCP 응답 전에 동기적으로 재인덱싱됩니다. 다음 원격 호출에서
watcher를 기다리지 않고 바로 변경 사항이 보입니다.

## 7. 두 서비스를 자동 실행

### macOS

source checkout에서:

```bash
OBSIDIAN_VAULT_PATH="/vault/절대/경로" \
OBSIDIAN_EVERYWHERE_TOKEN="<MCP-bearer-token>" \
OBSIDIAN_EVERYWHERE_MOUNT_GUARD=true \
OBSIDIAN_EVERYWHERE_MOUNT_SENTINEL=".obsidian/app.json" \
./scripts/install-launchagent.sh
```

`ngrok config check`가 출력한 경로로 native service를 설치합니다.

```bash
sudo ngrok service install --config "/ngrok.yml/절대/경로"
sudo ngrok service start
```

LaunchAgent는 `RunAtLoad`와 `KeepAlive`를 사용합니다. 로그인 시 외장 drive가
없으면 mount guard가 빈 인덱스로 덮어쓰지 않고 실패하며 launchd가 재시도합니다.

### Linux

Docker Compose가 가장 host-neutral한 방법입니다.

```bash
cp .env.example .env
```

최소 설정:

```dotenv
OBSIDIAN_VAULT_HOST_PATH=/vault/절대/경로
OBSIDIAN_EVERYWHERE_TOKEN=<MCP-bearer-token>
OBSIDIAN_EVERYWHERE_MOUNT_GUARD=true
OBSIDIAN_EVERYWHERE_MOUNT_SENTINEL=.obsidian/app.json
```

실행:

```bash
docker compose up -d obsidian-everywhere
ngrok service install --config /ngrok.yml/절대/경로
ngrok service start
```

NAS라면 Docker 전에 host OS에 share를 mount해야 합니다. sentinel은 container
내부 `/vault` 기준 상대경로입니다.

### Windows

`.env`에 Windows host 절대경로를 넣어 Docker Compose로 HTTP 서비스를
실행하고 ngrok을 Windows service로 설치합니다.

```powershell
ngrok service install --config "$env:LocalAppData\ngrok\ngrok.yml"
ngrok service start
```

sentinel은 `.obsidian/app.json`처럼 slash를 사용한 vault-relative 경로입니다.

## 운영

### Health와 상태

- `GET /healthz`: 인증 없이 mount를 즉시 확인하고 최소 서비스/mount
  상태를 반환합니다. guarded 인덱스가 stale할 수 있으면 `503`.
- `vault_status`: mount를 즉시 확인한 뒤 indexed count, 쓰기 가능 여부,
  sentinel, 마지막 전체 재조정을 자세히 반환합니다.
- `vault_overview`: stale 가능성이 있으면 경고를 포함합니다.

### Token 교체

1. 새 MCP bearer token 생성
2. 로컬 서비스 환경변수 갱신 후 재시작
3. 원격 MCP 등록을 새 header로 다시 생성
4. 이전 token이 `401`인지 확인

ngrok authtoken 교체는 MCP bearer token을 교체하지 않습니다.

### Backup

원격 쓰기를 켰다면 평소 vault backup이 더 중요합니다. Obsidian Sync, Git,
filesystem snapshot 등 이미 신뢰하는 수단을 사용하세요. bulk 작업의 rollback
snapshot은 전체 vault backup을 대체하지 않습니다.

## 문제 해결

| 증상 | 가능한 원인 | 확인 |
|---|---|---|
| MCP는 Connected인데 노트 0개 | HTTP 프로세스가 비어 있거나 잘못된 mount를 인덱싱 | `vault_status`, 로컬 `doctor`, 절대경로를 비교하고 sentinel mount guard 활성화 |
| `/healthz`가 503 | mount unavailable 또는 재조정 중 | drive/share를 복구하고 `vault_status: healthy` 대기 |
| 401 Unauthorized | client/server token 불일치 | MCP 등록을 다시 입력하고 공유 시 header 가림 |
| 429 Too Many Requests | 잘못된 token 반복 요청 | 잘못된 client를 중지하고 header 확인 후 rate-limit window 대기 |
| browser에서는 URL이 열리지만 MCP 실패 | `/mcp` 경로나 Authorization header 오류 | origin이 아니라 `https://domain/mcp` 사용 |
| 로컬 목록은 맞지만 원격 목록이 다름 | ngrok이 다른 port/process로 전달 | `upstream.url`과 Traffic Inspector 확인 |
| 실제 PDF/PPTX/DOCX를 찾지 못함 | agent가 노트 전용 도구나 부정확한 경로를 사용했거나 이전 프로세스가 watcher event를 놓침 | `list_folder`/`search_files`로 찾은 뒤 정확한 vault 상대경로(예: `Projects/final.pptx`)로 `read_file` 호출; 파일명 검색이 없으면 서비스 update/restart |
| 쓰기가 blocked | mount guard unavailable/reconciling | 우회하지 말고 mount 복구 후 재조정 대기 |
| 재시작 후 URL 변경 | ephemeral endpoint 사용 | 할당된 고정 개발 domain 또는 reserved/custom domain 설정 |
| SQLite native module version 오류 | 설치 뒤 Node version 변경 | 지원 Node version에서 dependency 재설치/rebuild |

foreground agent에서 local Traffic Inspector는 보통
`http://127.0.0.1:4040`에 있습니다. ngrok Dashboard Traffic Inspector로도
요청이 의도한 upstream에 도착했는지 볼 수 있습니다. MCP body에는 private
노트가 포함될 수 있으므로 full-body capture는 꼭 필요할 때만 켜고 이후
끄세요.

## 이 기능의 범위

Remote Vault Bridge는 로컬에 mount된 단일 vault를 원격에서 사용하게 합니다.
다음 기능은 제공하지 않습니다.

- 기기 간 vault 파일 동기화
- multi-user 또는 folder별 권한
- 동시 편집 conflict 자동 해결
- vault가 unmount된 동안 최신 파일 본문 제공

guarded outage 중 기존 indexed 검색 결과는 stale 표시와 함께 읽을 수 있지만,
재조정이 성공할 때까지 쓰기는 거부됩니다.
