# 배포 가이드

[English](deploy.md) | [한국어](deploy.ko.md)

Obsidian Everywhere는 로컬, 사설 원격, 공개 MCP 클라이언트를 위한 세 가지 배포 방식을 제공합니다. 기본 SQLite 파일은 transport별로 분리됩니다. `OBSIDIAN_EVERYWHERE_DB`를 override할 때도 프로세스마다 서로 다른 경로를 사용하세요. 쓰기 도구는 Markdown 파일을 실제로 변경하므로 같은 노트에 대한 동시 쓰기와 vault 동기화 충돌에 주의하세요.

| 클라이언트 | Transport | 인증 | 실행 위치 |
|---|---|---|---|
| 로컬 Codex CLI / ChatGPT Desktop / Claude | stdio | 없음 | vault와 같은 컴퓨터 |
| 원격 Codex / ChatGPT Desktop / Claude | Streamable HTTP | 정적 bearer token | Tailscale 사설망 내부 |
| claude.ai 웹·모바일 connector | Streamable HTTP | OAuth 2.1 | Cloudflare Tunnel 등의 공개 HTTPS |

## 1. 로컬 stdio

vault가 있는 컴퓨터에서 설치하고 빌드합니다.

```bash
npm install
npm run build
codex mcp add obsidian-everywhere -- node "$(pwd)/dist/cli.js" /절대/경로/내/vault
codex mcp list
```

Codex CLI, IDE extension, ChatGPT Desktop은 `~/.codex/config.toml`을 공유합니다. 등록 후 ChatGPT Desktop을 재시작하세요. Claude Code는 같은 stdio 명령을 별도로 등록합니다.

```bash
claude mcp add obsidian-everywhere -- node "$(pwd)/dist/cli.js" /절대/경로/내/vault
```

수동 TOML 설정과 Claude Desktop JSON 예시는 [한국어 README](../README.ko.md)를 참고하세요.

## 2. Tailscale를 통한 원격 연결

vault가 있는 Mac에서 LaunchAgent로 설치할 수 있습니다.

```bash
OBSIDIAN_VAULT_PATH=/절대/경로/내/vault \
OBSIDIAN_EVERYWHERE_TOKEN=$(openssl rand -hex 32) \
./scripts/install-launchagent.sh
```

이 서비스는 포트 3737에서 실행되며 `logs/http.out.log`, `logs/http.err.log`에 기록합니다.

```bash
curl http://127.0.0.1:3737/healthz
```

다른 컴퓨터의 Codex에서 다음과 같이 등록합니다. 이 설정은 ChatGPT Desktop과 공유됩니다.

```bash
export OBSIDIAN_EVERYWHERE_CLIENT_TOKEN="<서버의 토큰>"
codex mcp add obsidian-everywhere-remote \
  --url http://<Mac의-Tailscale-주소>:3737/mcp \
  --bearer-token-env-var OBSIDIAN_EVERYWHERE_CLIENT_TOKEN
```

ChatGPT Desktop을 실행할 때도 토큰 환경 변수가 전달되어야 합니다. Claude Code에서는 해당 URL과 `Authorization: Bearer <토큰>` header를 사용합니다.

Docker 기반 서버에서는 `.env.example`을 복사해 vault host path와 token을 설정합니다.

```bash
cp .env.example .env
docker compose up -d obsidian-everywhere
```

**포트 3737을 공개 인터넷에 노출하지 마세요.** 자체 TLS가 없고 하나의 정적 token으로 보호되므로 Tailscale 같은 사설망 내부에서만 사용해야 합니다.

## 3. claude.ai용 OAuth 및 Cloudflare Tunnel

claude.ai 서버는 localhost나 Tailscale 사설망에 접근할 수 없으므로 공개 HTTPS endpoint가 필요합니다.

### 3a. OAuth HTTP 서비스 실행

```bash
cp .env.example .env
docker compose up -d obsidian-everywhere-oauth
```

직접 실행할 수도 있습니다.

```bash
OBSIDIAN_VAULT_PATH=/절대/경로/내/vault \
OAUTH_ISSUER_URL=https://obsidian.example.com \
OAUTH_LOGIN_SECRET=<긴-secret> \
node dist/oauth-http-cli.js
```

`OAUTH_ISSUER_URL`은 tunnel에서 사용할 공개 HTTPS origin과 정확히 일치해야 합니다.

### 3b. Cloudflare Tunnel 구성

```bash
brew install cloudflared
TUNNEL_HOSTNAME=obsidian.example.com ./scripts/setup-cloudflare-tunnel.sh
```

스크립트가 생성한 설정을 사용해 계정 로그인, tunnel 생성, DNS 연결을 진행합니다.

```bash
cloudflared tunnel login
cloudflared tunnel create obsidian-everywhere
cloudflared tunnel route dns obsidian-everywhere obsidian.example.com
cloudflared tunnel --config ~/.cloudflared/obsidian-everywhere.yml run obsidian-everywhere
```

외부 네트워크에서 확인합니다.

```bash
curl https://obsidian.example.com/healthz
curl https://obsidian.example.com/.well-known/oauth-authorization-server
```

### 3c. claude.ai connector 등록

1. claude.ai → Settings → Connectors → Add custom connector로 이동합니다.
2. 서버 URL에 `https://obsidian.example.com/mcp`를 입력합니다.
3. OAuth metadata가 자동 발견되면 이 서버의 로그인 화면으로 이동합니다.
4. `OAUTH_LOGIN_SECRET`을 입력합니다.
5. PKCE code 교환이 끝나면 connector가 활성화됩니다.

공개 OAuth transport에서는 쓰기 도구가 기본 비활성화됩니다. 필요한 경우에만 `OAUTH_ENABLE_WRITE_TOOLS=true`로 활성화하세요.

## Vault 동기화

이 서버는 vault 자체를 컴퓨터 사이에서 동기화하지 않습니다. Git, Obsidian Sync 등 기존 동기화 수단을 사용해야 합니다.

새 파일이나 변경 파일이 디스크에 도착하면 `chokidar` watcher가 생성·수정·삭제·이름 변경을 감지해 SQLite 인덱스와 인메모리 그래프를 증분 갱신합니다. 오랫동안 꺼져 있던 프로세스가 다시 시작되면 mtime과 hash를 비교하는 전체 scan이 실행되며 실제로 달라진 파일만 다시 파싱합니다.
