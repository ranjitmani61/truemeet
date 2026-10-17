#!/bin/sh
# TrueMeet installer for macOS and Linux. No admin rights; everything goes in ~/.truemeet.
#   curl -fsSL https://raw.githubusercontent.com/ranjitmani61/truemeet/main/install.sh | sh
# Uses your Node.js if it is 20.11 or newer; otherwise downloads a private copy, verified against
# nodejs.org's published SHA-256 sums. Run it again to update; `rm -rf ~/.truemeet` uninstalls.
#   TRUEMEET_HOME=/some/dir   install somewhere else
#   TRUEMEET_NO_START=1       install only, don't start
set -eu
REPO=ranjitmani61/truemeet
NODE_VERSION=24.11.0
DIR=${TRUEMEET_HOME:-"$HOME/.truemeet"}

say() { if [ -t 1 ]; then printf '\033[1;35m>\033[0m %s\n' "$*"; else printf '> %s\n' "$*"; fi; }
fail() { printf 'TrueMeet install failed: %s\n' "$*" >&2; exit 1; }
for tool in curl tar; do command -v "$tool" >/dev/null 2>&1 || fail "please install $tool first"; done

case "$(uname -s)" in
  Darwin) os=darwin ;;
  Linux) os=linux ;;
  *) fail "unsupported system $(uname -s) (on Windows, use install.ps1)" ;;
esac
case "$(uname -m)" in
  x86_64 | amd64) arch=x64 ;;
  arm64 | aarch64) arch=arm64 ;;
  *) fail "unsupported CPU $(uname -m)" ;;
esac

node_ok() { "$1" -e 'const [a, b] = process.versions.node.split(".").map(Number); process.exit(a > 20 || (a === 20 && b >= 11) ? 0 : 1)' 2>/dev/null; }
sha256() { (sha256sum "$1" 2>/dev/null || shasum -a 256 "$1") | awk '{ print $1 }'; }

mkdir -p "$DIR"
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

if command -v node >/dev/null 2>&1 && node_ok node; then
  NODE=$(command -v node)
  say "Using your Node.js $(node -v)"
else
  NODE="$DIR/node/bin/node"
  if ! node_ok "$NODE"; then
    # nodejs.org builds need glibc; Alpine and other musl systems should use their own package.
    if [ "$os" = linux ] && ldd --version 2>&1 | grep -qi musl; then fail "this Linux uses musl: install Node.js 24 with your package manager (e.g. apk add nodejs), then run this again"; fi
    name="node-v$NODE_VERSION-$os-$arch"
    say "Downloading Node.js $NODE_VERSION ($os-$arch)..."
    curl -fsSL "https://nodejs.org/dist/v$NODE_VERSION/$name.tar.gz" -o "$tmp/node.tar.gz"
    want=$(curl -fsSL "https://nodejs.org/dist/v$NODE_VERSION/SHASUMS256.txt" | awk -v f="$name.tar.gz" '$2 == f { print $1 }')
    [ -n "$want" ] && [ "$want" = "$(sha256 "$tmp/node.tar.gz")" ] || fail "the Node.js download didn't match its published checksum"
    rm -rf "$DIR/node" && mkdir -p "$DIR/node"
    tar -xzf "$tmp/node.tar.gz" -C "$DIR/node" --strip-components=1
  fi
fi

say "Downloading TrueMeet..."
curl -fsSL "https://codeload.github.com/$REPO/tar.gz/refs/heads/main" -o "$tmp/app.tar.gz"
mkdir -p "$tmp/app"
tar -xzf "$tmp/app.tar.gz" -C "$tmp/app" --strip-components=1
[ -f "$tmp/app/server.js" ] || fail "the TrueMeet download looks incomplete"
rm -rf "$DIR/app" && mv "$tmp/app" "$DIR/app"

mkdir -p "$DIR/bin"
cat > "$DIR/bin/truemeet" <<EOF
#!/bin/sh
# Restarts only this installation's TrueMeet; other listeners are left running.
port=\${PORT:-3000}
if command -v lsof >/dev/null 2>&1; then pids=\$(lsof -ti "tcp:\$port" -sTCP:LISTEN 2>/dev/null)
elif command -v fuser >/dev/null 2>&1; then pids=\$(fuser "\$port/tcp" 2>/dev/null)
else pids=; fi
if [ -n "\$pids" ]; then
  # Check every listener before stopping any of them; a script name alone is not proof.
  for pid in \$pids; do
    command=\$(ps -ww -o args= -p "\$pid" 2>/dev/null) || continue
    case "\$command" in
      "$NODE $DIR/app/server.js" | "$NODE $DIR/app/server.js "*) ;;
      *) printf 'Port %s is already in use by %s (PID %s). Nothing was stopped. Set PORT to a free port.\n' "\$port" "\$command" "\$pid" >&2; exit 1 ;;
    esac
  done
  for pid in \$pids; do
    command=\$(ps -ww -o args= -p "\$pid" 2>/dev/null) || continue
    case "\$command" in
      "$NODE $DIR/app/server.js" | "$NODE $DIR/app/server.js "*)
        echo "Port \$port: stopping TrueMeet (PID \$pid)"
        kill "\$pid" 2>/dev/null || continue
        i=0; while [ \$i -lt 30 ] && kill -0 "\$pid" 2>/dev/null; do sleep 0.1; i=\$((i + 1)); done
        if kill -0 "\$pid" 2>/dev/null; then echo "TrueMeet (PID \$pid) did not stop. Choose another PORT or stop it manually." >&2; exit 1; fi
        ;;
      *) echo "Port \$port changed owners. Nothing was stopped. Choose another PORT." >&2; exit 1 ;;
    esac
  done
fi
PORT=\$port exec "$NODE" "$DIR/app/server.js" "\$@"
EOF
chmod +x "$DIR/bin/truemeet"
say "Installed. Start it any time with: $DIR/bin/truemeet"

if [ -z "${TRUEMEET_NO_START:-}" ]; then
  say "Starting TrueMeet (Ctrl+C to stop)..."
  exec "$DIR/bin/truemeet"
fi
