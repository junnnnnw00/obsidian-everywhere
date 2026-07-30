<div align="center">

[English](README.md) | [한국어](README.ko.md)

# 🧠 Obsidian Everywhere

**연결된 노트를 AI 컨텍스트로 만들고, 로컬 vault를 어디서 실행되는 에이전트와도 안전하게 연결하세요.**

[![CI](https://github.com/junnnnnw00/obsidian-everywhere/actions/workflows/ci.yml/badge.svg)](https://github.com/junnnnnw00/obsidian-everywhere/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/obsidian-everywhere?logo=npm)](https://www.npmjs.com/package/obsidian-everywhere)
[![npm downloads](https://img.shields.io/npm/dt/obsidian-everywhere?logo=npm&label=downloads)](https://www.npmjs.com/package/obsidian-everywhere)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

*그래프 컨텍스트 · 로컬 시맨틱 검색 · 안전한 편집 · MCP 기반 원격 에이전트*

[![obsidian-everywhere MCP server](https://glama.ai/mcp/servers/junnnnnw00/obsidian-everywhere/badges/card.svg)](https://glama.ai/mcp/servers/junnnnnw00/obsidian-everywhere)

</div>

## 44초로 보는 Remote Vault Bridge

![Remote Vault Bridge 데모 — 원격 에이전트가 그래프·시맨틱 컨텍스트를 검색하고 안전하게 수정한 뒤 로컬 vault 연결 끊김에서 복구](assets/remote-vault-bridge-demo.gif)

[원격 연결 가이드](docs/ngrok-remote.md)

*원격 요청 → 시맨틱 검색 → 그래프 컨텍스트 → 보호된 편집 → mount-loss 복구*

---

Obsidian Everywhere는 두 가지 생각을 중심으로 설계되었습니다.

1. **노트는 텍스트 파일 폴더가 아니라 그래프이자 의미 기반 지식베이스입니다.**
   백링크, n-hop 이웃, 최단 경로, PageRank, 전문 검색과 로컬 다국어
   임베딩으로 주제에 필요한 컨텍스트를 구성합니다.
2. **에이전트가 실행되는 곳에서 내 vault를 사용할 수 있어야 합니다.**
   Remote Vault Bridge는 같은 그래프와 보호된 쓰기 도구를 인증된
   Streamable HTTP로 제공합니다. 외부 서버의 Claude Code나 Codex가 내
   컴퓨터에 남아 있는 vault를 검색하고, 추론하고, 수정할 수 있습니다.

로컬 vault가 계속 원본입니다. 호스팅된 사본이나 telemetry, 필수 클라우드
계정은 없습니다. 원격 연결은 사용자가 직접 운영하는 transport입니다.

## 목차

- [44초로 보는 Remote Vault Bridge](#44초로-보는-remote-vault-bridge)
- [주요 기능](#주요-기능)
- [두 가지 핵심 기능](#두-가지-핵심-기능)
- [내 vault 없이 체험하기](#내-vault-없이-체험하기)
- [왜 Obsidian Everywhere인가요?](#왜-obsidian-everywhere인가요)
- [서버는 어디에서 실행되나요?](#서버는-어디에서-실행되나요)
- [빠른 시작](#빠른-시작)
- [환경 변수](#환경-변수)
- [개발](#개발)
- [프로젝트 상태](#프로젝트-상태)

## 주요 기능

```text
vault (.md 파일)
  │  파싱 · 감시
  ▼
SQLite 인덱스 (FTS5)  ⇄  인메모리 그래프 (graphology)
  │                         n-hop · 최단 경로 · PageRank
  ▼
39개 MCP 도구
  │
  ▼
로컬 stdio  ·  인증된 원격 HTTP  ·  OAuth HTTP
```

- **그래프 + 시맨틱 컨텍스트 엔진** — wikilink, embed, frontmatter,
  중첩 태그, heading, block reference를 파싱하고 SQLite 전문 검색과
  graphology 기반 n-hop·최단 경로·PageRank를 제공합니다.
- **Remote Vault Bridge** — 외부 서버의 에이전트가 인증된 Streamable
  HTTP를 통해 같은 검색·그래프·컨텍스트·편집 도구를 사용합니다. 사설망
  또는 ngrok 같은 HTTPS tunnel을 사용하며 vault 자체는 내 컴퓨터에 남습니다.
- **완전 로컬 시맨틱 검색** — `semantic_search`와 `get_related`의 `method: "semantic"`은 소형 다국어 임베딩 모델(`multilingual-e5-small`)을 로컬에서 실행합니다. API key, 클라우드 계정, Ollama 프로세스 필요 없음 — 최초 1회(~120MB)만 받으면 이후 완전 오프라인으로 동작합니다.
- **안전한 쓰기와 mount 복구** — 부분 편집, dry-run 우선 일괄 작업,
  rollback snapshot, 복구 가능한 삭제를 제공합니다. opt-in Beta mount
  guard는 외장 드라이브·NAS·container mount가 사라지면 인덱스를 보존하고
  쓰기를 차단한 뒤, 복귀 시 전체 재조정합니다.
- **39개 MCP 도구** — 구조화 읽기, 그래프 탐색, 시맨틱 검색, 안전한
  수명주기 작업, Obsidian 설정과 명시적인 `vault_status`를 제공합니다.

## 두 가지 핵심 기능

### 1. 연결된 vault를 집중된 AI 컨텍스트로

전문 검색은 실제로 쓴 단어를 찾고, 시맨틱 검색은 표현이나 언어가 달라도
같은 아이디어를 찾습니다. 그래프 탐색은 검색된 노트들이 어떻게 연결되는지
설명합니다. `get_context_bundle`은 이 신호를 토큰 예산 안의 컨텍스트 묶음으로
만들어 vault 전체를 무작정 모델에 넣지 않도록 합니다.

### 2. 외부 서버에서 그 컨텍스트를 읽고 수정

Obsidian Everywhere를 로컬 vault 옆에서 실행하고 HTTP endpoint를 사설망이나
HTTPS tunnel로 노출한 뒤 원격 MCP 클라이언트에 등록합니다. 원격 에이전트는
로컬 vault를 읽고 검색한 다음 같은 보호 도구로 노트를 생성·추가·이동·태그
정리할 수 있습니다. 성공한 쓰기는 응답 전에 재인덱싱되므로 다음 원격 호출에
즉시 반영됩니다.

전체 과정은 **[ngrok Remote Vault Bridge 튜토리얼](docs/ngrok-remote.ko.md)**을
참고하세요.

### 제공 도구

| 읽기 도구 | 용도 |
|---|---|
| `vault_overview` | 노트 수, 주요 태그, PageRank 허브, 최근 수정 노트 확인 |
| `vault_status` | mount 상태, 인덱스 freshness, 쓰기 가능 여부와 마지막 전체 재조정 확인 |
| `search_notes` | 본문·제목 전문 검색과 태그·폴더 필터 (한글 등 CJK 복합어 부분검색은 trigram으로 보완 — DECISIONS.md D9 참고) |
| `semantic_search` | 로컬 임베딩(`multilingual-e5-small`, 외부 서비스 없음) 기반 의미 검색 — 쿼리와 표현이 달라도 개념적으로 관련된 노트를 찾음 |
| `read_note` | `content`, frontmatter, 링크, 태그를 구조화해 반환하고 줄 단위 페이지네이션 지원 |
| `list_notes` | 폴더 범위와 페이지네이션을 지원하는 명시적 노트 목록 |
| `list_folder` | 한 폴더 바로 아래의 하위 폴더·노트·첨부파일 목록 |
| `regex_search` | 파일·줄·문맥을 포함한 정규식 검색 |
| `get_backlinks` | 특정 노트를 링크한 모든 노트와 해당 문장 조회 |
| `get_neighborhood` | 노트 주변 n-hop 노드와 edge 조회 |
| `get_context_bundle` | 토큰 예산 안에서 중심 노트와 관련 이웃을 묶어 조회 |
| `list_tags` | 중첩 태그 계층과 노트 수 조회 |
| `get_notes_by_tag` | 지정한 태그를 가진 노트 조회 |
| `find_orphans` | 입출력 링크가 없는 노트 검색 |
| `find_unresolved` | 아직 존재하지 않는 링크 검색 |
| `find_path` | 두 노트 사이의 최단 연결 경로 검색 |
| `get_related` | 직접 링크되지 않았지만 유사한 노트 추천 — 기본은 태그·이웃 Jaccard, `method: "semantic"`이면 임베딩 유사도 |
| `get_hotkeys`, `get_obsidian_settings` | 저장된 command ID·단축키, 템플릿 폴더, core plugin 설정 조회 |
| `validate_base` | `.base` 또는 fenced Base YAML의 정적 구문·구조 검증 |

| 쓰기 도구 | 용도 |
|---|---|
| `create_note` | frontmatter를 포함한 새 노트 생성 및 즉시 인덱싱 |
| `apply_template` | 템플릿 노트로 새 노트 생성, Obsidian core Templates 변수 `{{date}}`/`{{time}}`/`{{title}}` 치환 |
| `append_to_note` | 노트 끝이나 특정 heading 아래에 내용 추가 |
| `move_note`, `rename_note`, `delete_note` | 링크 갱신·백링크 보호·휴지통을 포함한 수명주기 작업 |
| `replace_text`, `patch_section` | 정확한 문구 또는 heading 범위 부분 수정 |
| `update_frontmatter`, `remove_frontmatter_field` | 본문을 건드리지 않는 frontmatter 수정 |
| `bulk_update_frontmatter`, `bulk_remove_frontmatter_field` | 폴더 또는 vault 전체의 frontmatter를 dry-run·파일 수 제한·rollback과 함께 수정 |
| `add_tags`, `remove_tags` | 노트 한 개의 frontmatter 태그 추가·삭제 |
| `rename_tag` | vault 전체에서 frontmatter와 본문 인라인 `#태그`를 함께 이름변경, 기본 dry-run + rollback 지원 |
| `bulk_replace`, `rollback_bulk_edit` | dry-run·파일 제한·snapshot·rollback이 있는 일괄 치환 |
| `set_hotkey`, `set_templates_folder` | 저장된 Obsidian 설정 수정(앱에서 vault reload가 필요할 수 있음) |

stdio와 bearer-token HTTP에서는 쓰기 도구가 기본 활성화됩니다. 공개 OAuth 연결에서는 기본 비활성화되며 `OAUTH_ENABLE_WRITE_TOOLS=true`로 명시적으로 켤 수 있습니다.

자세한 내부 구조는 [아키텍처 문서](docs/architecture.md), 운영 구성은
[한국어 배포 가이드](docs/deploy.ko.md), 외부 서버 연결은
[ngrok 튜토리얼](docs/ngrok-remote.ko.md)을 참고하세요.

## 내 vault 없이 체험하기

먼저 내장 데모를 실행해 보세요. 임시 샘플 vault를 만들고 그래프 개요,
미해결 링크 탐색, 안전한 일괄 편집 dry-run을 보여준 뒤 샘플을 삭제합니다.
사용자의 실제 노트는 읽거나 변경하지 않습니다.

```bash
npx -y obsidian-everywhere demo
```

![Obsidian Everywhere 데모: 컨텍스트 번들, 관련 노트 추천, 그래프 경로, 미해결 링크, 링크 보존 이동, 롤백 가능한 일괄 편집](assets/demo.gif)

실제 vault를 연결할 준비가 되면 클라이언트 설정과 진단 결과를 생성합니다.

```bash
npx -y obsidian-everywhere init /절대/경로/내/vault
npx -y obsidian-everywhere doctor /절대/경로/내/vault
```

`init`은 Codex, ChatGPT Desktop, Claude Code, Claude Desktop용 설정을 출력할
뿐 전역 설정 파일을 수정하지 않습니다. `doctor`는 노트 내용을 출력하지
않고 Node.js, 권한, Obsidian 설정, SQLite, 파서와 그래프 엔진을 검사합니다.
이슈에 결과를 붙일 때 `--share`를 추가하면 vault 경로도 가려집니다.

## 왜 Obsidian Everywhere인가요?

좋은 Obsidian MCP가 이미 여러 개 있습니다. 하나가 모든 면에서 우월하다고
주장하기보다 자신의 사용 방식에 맞는 구조를 선택하는 편이 정확합니다.

| | **Obsidian Everywhere** | [obsidian-mcp-server](https://github.com/cyanheads/obsidian-mcp-server) | [Local REST API](https://github.com/coddingtonbear/obsidian-local-rest-api) | [TurboVault](https://github.com/epistates/turbovault) |
|---|---|---|---|---|
| 설치 | `npx` | `npx` | Obsidian community plugin | `cargo install` / binary |
| 공개된 도구 수 | **39** | 14 | 16 | 74 |
| Obsidian 실행 필요 | **아니요** | 예 | 예 | **아니요** |
| 대표 그래프 기능 | PageRank·최단 경로·n-hop·미해결 링크 | 구조화 읽기의 outgoing links | 실행 중인 Obsidian metadata/search | multi-hop·centrality·cluster·추천 |
| 안전한 편집 | 부분 편집·bulk dry-run·snapshot·rollback | 정밀 편집·frontmatter/tag 관리 | live heading/block/frontmatter patch | conflict hash·audit rollback·Git batch |
| 현재 파일·앱 명령 | 저장 설정만 조회 | **지원** | **지원** | 미지원 |
| 원격 transport | stdio·사설망 또는 HTTPS tunnel의 bearer HTTP·**OAuth 2.1** | stdio·JWT/OAuth HTTP | API key HTTP | stdio·HTTP·WebSocket·TCP |
| 특히 잘 맞는 경우 | headless vault의 그래프·시맨틱 context와 보호된 원격 접근·편집 | 앱 기반 CRUD와 Omnisearch | 실행 중인 Obsidian 직접 제어 | 최대 기능 폭·multi-vault·고급 분석 |

2026-07-20 각 프로젝트의 공개 문서를 기준으로 확인했습니다. 실행 중인 앱의
현재 파일이나 command palette 제어가 중요하면 plugin 기반 서버가 더 적합합니다.
앱 없이 `npx` 한 줄로 실행하고, token-budgeted context와 보호 장치가 있는
그래프 정리를 원한다면 Obsidian Everywhere가 겨냥한 영역입니다.

기본 동작은 완전한 로컬 실행입니다. 계정, API key, hosted vault, telemetry가
필요하지 않습니다.

## 서버는 어디에서 실행되나요?

`obsidian-everywhere` 프로세스는 vault의 `.md` 파일을 직접 읽고 변경을 감시해야 합니다. 따라서 **vault 파일이 실제로 존재하는 컴퓨터**에서 실행해야 합니다. 클라이언트가 다른 컴퓨터에 있더라도 서버 위치는 바뀌지 않고 연결 방식만 달라집니다.

| 사용 환경 | 연결 방법 |
|---|---|
| vault와 같은 컴퓨터의 Codex, ChatGPT Desktop, Claude | **stdio** — 클라이언트가 서버 프로세스를 직접 실행 |
| 내가 관리하는 다른 컴퓨터 | **bearer-token HTTP** — Tailscale 같은 사설망 또는 [ngrok HTTPS tunnel](docs/ngrok-remote.ko.md) |
| claude.ai 웹·모바일 | **OAuth HTTP + 공개 HTTPS 주소** — Cloudflare Tunnel 사용 가능 |

여러 transport 프로세스를 동시에 실행할 수도 있습니다. v0.2부터 기본 DB 파일은 transport별(`index-stdio.db`, `index-http.db`, `index-oauth.db`)로 분리됩니다. `OBSIDIAN_EVERYWHERE_DB`를 직접 지정할 때도 프로세스마다 서로 다른 경로를 사용하세요.

## 빠른 시작

clone이나 build 없이 vault가 있는 컴퓨터에서 바로 실행합니다.

```bash
npx -y obsidian-everywhere /절대/경로/내/vault
```

실제로는 아래 설정을 통해 MCP 클라이언트가 이 명령을 자동 실행합니다.

경로와 실행 환경을 먼저 확인하려면 노트 내용을 노출하지 않는 진단을 실행하세요.

```bash
npx -y obsidian-everywhere doctor /절대/경로/내/vault
```

### Codex CLI 및 ChatGPT Desktop — 로컬 stdio

Codex CLI, Codex IDE extension, ChatGPT Desktop의 Codex 기능은 같은 MCP 설정을 공유합니다. 한 번만 등록하면 됩니다.

```bash
codex mcp add obsidian-everywhere -- npx -y obsidian-everywhere /절대/경로/내/vault
codex mcp list
```

등록 후 ChatGPT Desktop 또는 IDE extension을 재시작하세요. ChatGPT Desktop의 **Settings → MCP servers → Add server**에서 **STDIO**를 선택해 같은 command와 args를 입력할 수도 있습니다. Codex에서 `/mcp`를 입력하면 서버와 도구 연결 상태를 확인할 수 있습니다.

프로젝트 단위로 설정하려면 신뢰된 프로젝트의 `.codex/config.toml`에 아래 내용을 추가하세요. 모든 프로젝트에서 사용하려면 `~/.codex/config.toml`을 사용합니다.

```toml
[mcp_servers.obsidian-everywhere]
command = "npx"
args = ["-y", "obsidian-everywhere", "/절대/경로/내/vault"]
startup_timeout_sec = 30
```

vault에는 반드시 절대경로를 사용하세요. GUI 앱은 터미널과 같은 `PATH`를 상속하지 않을 수 있습니다. `npx`를 찾지 못하면 `command -v npx`의 절대경로를 `command`에 넣으세요. 자세한 현재 설정 형식은 [OpenAI 공식 MCP 문서](https://learn.chatgpt.com/docs/extend/mcp)를 참고하세요.

### Claude Code — 로컬 stdio

```bash
claude mcp add obsidian-everywhere -- npx -y obsidian-everywhere /절대/경로/내/vault
```

### Claude Desktop — 로컬 stdio

`claude_desktop_config.json`에 추가합니다.

```json
{
  "mcpServers": {
    "obsidian-everywhere": {
      "command": "npx",
      "args": ["-y", "obsidian-everywhere", "/절대/경로/내/vault"]
    }
  }
}
```

### Codex 및 ChatGPT Desktop — 다른 컴퓨터에서 연결

vault 컴퓨터에서 HTTP 서버를 실행합니다.

```bash
OBSIDIAN_VAULT_PATH=/절대/경로/내/vault \
OBSIDIAN_EVERYWHERE_TOKEN=$(openssl rand -hex 32) \
npx -y --package obsidian-everywhere obsidian-everywhere-http
```

두 컴퓨터를 Tailscale 같은 사설망에 연결한 뒤 클라이언트 컴퓨터에서
등록합니다. 공용 인터넷을 통해 연결하려면 로컬 HTTP 포트를 직접 열지 말고,
read-only부터 시작하는 [ngrok Remote Vault Bridge 튜토리얼](docs/ngrok-remote.ko.md)을
따르세요.

```bash
export OBSIDIAN_EVERYWHERE_CLIENT_TOKEN="<서버에서 생성한 토큰>"
codex mcp add obsidian-everywhere \
  --url http://<vault-컴퓨터의-tailscale-주소>:3737/mcp \
  --bearer-token-env-var OBSIDIAN_EVERYWHERE_CLIENT_TOKEN
```

ChatGPT Desktop 프로세스에서도 이 환경 변수를 사용할 수 있어야 합니다. 포트 3737은 자체 암호화를 제공하지 않으므로 공개 인터넷에 노출하지 마세요. 전체 과정은 [한국어 배포 가이드](docs/deploy.ko.md)를 참고하세요.

### claude.ai 웹·모바일 — OAuth connector

공개 HTTPS endpoint가 필요합니다. OAuth 서버와 Cloudflare Tunnel 구성 후 claude.ai의 Settings → Connectors → Add custom connector에 `https://내-도메인/mcp`를 등록합니다. 자세한 내용은 [한국어 배포 가이드](docs/deploy.ko.md)를 참고하세요.

## 환경 변수

| 환경 변수 | 사용 위치 | 의미 |
|---|---|---|
| `OBSIDIAN_VAULT_PATH` | 전체 | vault 경로. stdio CLI의 위치 인자로도 전달 가능 |
| `OBSIDIAN_EVERYWHERE_DB` | 전체 | SQLite 인덱스 경로 override. 기본값은 `<vault>/.obsidian-everywhere/index-stdio.db`, `index-http.db`, `index-oauth.db` 중 transport에 해당하는 파일 |
| `OBSIDIAN_EVERYWHERE_TOKEN` | `http-cli.js` | 정적 bearer token |
| `PORT` | HTTP entrypoint | HTTP 포트. 기본값은 3737 또는 3738 |
| `OAUTH_ISSUER_URL` | `oauth-http-cli.js` | 공개 HTTPS origin |
| `OAUTH_LOGIN_SECRET` | `oauth-http-cli.js` | 단일 사용자 로그인 secret |
| `OBSIDIAN_EVERYWHERE_READONLY` | stdio, bearer HTTP | `true`이면 쓰기 도구 비활성화 |
| `OBSIDIAN_EVERYWHERE_MOUNT_GUARD` | 모든 실행 방식 | opt-in Beta mount 장애 보호와 자동 재조정 |
| `OBSIDIAN_EVERYWHERE_MOUNT_SENTINEL` | 모든 실행 방식 | `.obsidian/app.json` 같은 vault-relative identity 경로 |
| `OBSIDIAN_EVERYWHERE_MOUNT_RECHECK_MS` | 모든 실행 방식 | 실행 중 mount 확인 간격(기본 `5000`) |
| `OAUTH_ENABLE_WRITE_TOOLS` | OAuth HTTP | `true`이면 공개 connector에서 쓰기 도구 활성화 |

## 개발

```bash
npm run dev:stdio
npm run dev:http
npm run dev:oauth-http
npm test
npm run typecheck
npm run lint
npm run format:check
```

`fixtures/test-vault/`에는 piped alias, heading·block link, embed, frontmatter wikilink, 중첩 태그, 같은 이름의 파일, 미해결 링크, 코드 블록 제외, 한국어 파일명·태그·wikilink를 검증하는 fixture가 있습니다.

## 프로젝트 상태

현재 v0.7.0은 그래프·로컬 시맨틱 context engine, stdio·bearer HTTP·OAuth
HTTP transport, MCP 도구 39개, 보호된 부분·일괄 편집과 Codex·ChatGPT
Desktop·Claude 설정을 제공합니다. Remote Vault Bridge는 정식 배포 경로이며,
선택형 mount guard는 removable drive·NAS·container mount 환경의 피드백을
받는 **Beta**입니다.

실제 원격 vault 설정을 테스트하려면
[Beta Issue #18](https://github.com/junnnnnw00/obsidian-everywhere/issues/18)에
참여하거나
[Discussion #19](https://github.com/junnnnnw00/obsidian-everywhere/discussions/19)에서
질문해 주세요. 임시 vault로도 충분하며 노트 내용, 토큰, 비공개 호스트명은
절대 공유하지 마세요.

버그 제보와 PR은 [CONTRIBUTING.md](CONTRIBUTING.md), 보안 문제는 [SECURITY.md](SECURITY.md)를 확인하세요. 라이선스는 [MIT](LICENSE)입니다.
