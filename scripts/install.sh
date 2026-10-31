#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
Usage: bash scripts/install.sh [--install-system-deps] [--install-node] [--node-version 24.14.0]

Builds this checkout without starting services or changing application data.
By default, requires Node.js >=24.14.0 <25, npm, Git and native build tools.
--install-system-deps explicitly permits apt packages on Debian/Ubuntu.
--install-node permits a verified official Node.js download into a local toolchain.
macOS uses the system Seatbelt executable.
PostgreSQL is deliberately configured separately; existing services are preserved.
EOF
}

install_system_deps=0
install_node=0
node_version=24.14.0
while (($#)); do
  case "$1" in
    --install-system-deps) install_system_deps=1; shift ;;
    --install-node) install_node=1; shift ;;
    --node-version)
      [[ $# -ge 2 ]] || { usage >&2; exit 2; }
      node_version=$2; shift 2 ;;
    --help|-h) usage; exit 0 ;;
    *) printf 'Unknown option: %s\n' "$1" >&2; usage >&2; exit 2 ;;
  esac
done
[[ "$node_version" =~ ^24\.([0-9]+)\.([0-9]+)$ ]] && ((10#${BASH_REMATCH[1]} >= 14)) || {
  printf 'Node version must be >=24.14.0 and <25.\n' >&2; exit 2;
}

project_root=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)
cd "$project_root"
[[ -f package-lock.json && -f apps/web/package-lock.json ]] || {
  printf 'Run from a complete source checkout with both lockfiles.\n' >&2; exit 1;
}
os_name=$(uname -s)
case "$os_name" in
  Linux) node_platform=linux ;;
  Darwin) node_platform=darwin ;;
  *) printf 'Use scripts/install.ps1 on Windows.\n' >&2; exit 1 ;;
esac
case "$(uname -m)" in
  x86_64|amd64) node_arch=x64 ;;
  arm64|aarch64) node_arch=arm64 ;;
  *) printf 'Unsupported CPU architecture.\n' >&2; exit 1 ;;
esac

if ((install_system_deps)) && [[ "$os_name" == Linux ]]; then
  command -v apt-get >/dev/null || {
    printf 'Automatic system packages support Debian/Ubuntu only. Install dependencies manually.\n' >&2; exit 1;
  }
  elevation=()
  if ((EUID != 0)); then
    command -v sudo >/dev/null || { printf 'sudo is required for apt packages.\n' >&2; exit 1; }
    elevation=(sudo)
  fi
  "${elevation[@]}" apt-get update
  "${elevation[@]}" apt-get install -y --no-install-recommends ca-certificates curl git build-essential bubblewrap python3
fi

valid_node() {
  command -v node >/dev/null && node -e 'const [a,b]=process.versions.node.split(".").map(Number);process.exit(a===24&&b>=14?0:1)' >/dev/null 2>&1
}
toolchain_dir="${XDG_DATA_HOME:-$HOME/.local/share}/nash-agents/toolchains/node-v${node_version}-${node_platform}-${node_arch}"
if ! valid_node && [[ -x "$toolchain_dir/bin/node" ]]; then
  export PATH="$toolchain_dir/bin:$PATH"
fi
install_tmp=
cleanup() { if [[ -n "$install_tmp" && -d "$install_tmp" ]]; then rm -rf -- "$install_tmp"; fi; }
trap cleanup EXIT
if ! valid_node; then
  if ((!install_node)); then
    printf 'Node.js >=24.14.0 <25 is required. Install it, or rerun with --install-node.\n' >&2
    exit 1
  fi
  command -v curl >/dev/null || { printf 'curl is required.\n' >&2; exit 1; }
  archive="node-v${node_version}-${node_platform}-${node_arch}.tar.gz"
  install_tmp=$(mktemp -d "${TMPDIR:-/tmp}/nash-agents-install.XXXXXXXX")
  curl --fail --location --proto '=https' --tlsv1.2 --connect-timeout 15 --max-time 300 \
    "https://nodejs.org/dist/v${node_version}/${archive}" -o "$install_tmp/$archive"
  curl --fail --location --proto '=https' --tlsv1.2 --connect-timeout 15 --max-time 60 \
    "https://nodejs.org/dist/v${node_version}/SHASUMS256.txt" -o "$install_tmp/SHASUMS256.txt"
  expected=$(awk -v name="$archive" '$2 == name {print $1}' "$install_tmp/SHASUMS256.txt")
  [[ "$expected" =~ ^[a-fA-F0-9]{64}$ ]] || { printf 'Official checksum is missing.\n' >&2; exit 1; }
  if command -v sha256sum >/dev/null; then actual=$(sha256sum "$install_tmp/$archive"); else actual=$(shasum -a 256 "$install_tmp/$archive"); fi
  [[ "${actual%% *}" == "$expected" ]] || { printf 'Node download checksum mismatch.\n' >&2; exit 1; }
  [[ ! -e "$toolchain_dir" ]] || { printf 'Toolchain directory already exists; inspect it before retrying: %s\n' "$toolchain_dir" >&2; exit 1; }
  mkdir -p -- "$(dirname -- "$toolchain_dir")"
  mkdir -- "$install_tmp/extracted"
  tar -xzf "$install_tmp/$archive" -C "$install_tmp/extracted" --strip-components=1
  mv -- "$install_tmp/extracted" "$toolchain_dir"
  export PATH="$toolchain_dir/bin:$PATH"
fi
valid_node || { printf 'Unsupported Node.js version.\n' >&2; exit 1; }
for executable in npm git; do
  command -v "$executable" >/dev/null || { printf 'Missing dependency: %s\n' "$executable" >&2; exit 1; }
done
if [[ "$os_name" == Linux ]]; then
  for executable in "${CC:-cc}" bwrap; do
    command -v "$executable" >/dev/null || { printf 'Missing dependency: %s. Use --install-system-deps or install it manually.\n' "$executable" >&2; exit 1; }
  done
else
  [[ -x /usr/bin/sandbox-exec ]] || { printf 'macOS sandbox-exec is unavailable; installation is blocked.\n' >&2; exit 1; }
fi

printf 'Installing locked dependencies and building this checkout...\n'
npm ci --no-audit
npm ci --prefix apps/web --no-audit
if [[ "$os_name" == Linux ]]; then npm run build:helper:linux; fi
npm run build:all
printf '\nBuild complete. Initialize explicitly: node dist/index.js init\n'
printf 'Current Node.js: %s\n' "$(command -v node)"
if [[ "$(command -v node)" == "$toolchain_dir/bin/node" ]]; then
  printf 'For a new shell, add this directory to PATH: %s/bin\n' "$toolchain_dir"
fi
