#!/usr/bin/env bash
#
# steam-vn-fix.sh
#
# Dò IP Akamai còn truy cập được cho các domain Steam đang bị chặn
# tại VN, rồi cập nhật /etc/hosts.
#
# TLS vẫn xác thực đầu-cuối với cert thật của Steam, nên nếu IP nào
# bị giả mạo thì trình duyệt sẽ báo lỗi certificate ngay.
#
#   sudo ./steam-vn-fix.sh          # dò và cập nhật hosts
#   sudo ./steam-vn-fix.sh --check  # chỉ kiểm tra, không sửa gì
#   sudo ./steam-vn-fix.sh --revert # gỡ block đã thêm
#
set -uo pipefail

HOSTS=/etc/hosts
BEGIN="# --- STEAM VN BYPASS - BEGIN ---"
END="# --- STEAM VN BYPASS - END ---"
RESOLVERS=(8.8.8.8 1.1.1.1 9.9.9.9 208.67.222.222)
TIMEOUT=6

DOMAINS=(
  store.steampowered.com
  steamcommunity.com
  api.steampowered.com
  login.steampowered.com
  checkout.steampowered.com
  help.steampowered.com
)

c_ok=$'\033[32m'; c_bad=$'\033[31m'; c_dim=$'\033[2m'; c_off=$'\033[0m'

need_root() {
  [[ $EUID -eq 0 ]] || { echo "Cần chạy với sudo." >&2; exit 1; }
}

# Trả về 0 nếu IP phục vụ được domain (bất kỳ mã HTTP nào cũng tính là thông)
probe() {
  local domain=$1 ip=$2 code
  code=$(curl -s -o /dev/null --max-time "$TIMEOUT" \
           -w '%{http_code}' \
           --resolve "${domain}:443:${ip}" \
           "https://${domain}/" 2>/dev/null)
  [[ -n $code && $code != 000 ]]
}

# Gom IP từ nhiều resolver, ưu tiên dải nội địa VN (118.x, 113.x, 27.x...)
collect_ips() {
  local domain=$1 r ip
  {
    for r in "${RESOLVERS[@]}"; do
      dig +short +time=2 +tries=1 "$domain" "@$r" 2>/dev/null | grep -E '^[0-9.]+$'
    done
  } | sort -u | awk '
      /^(118|113|27|14|123|171|203)\./ { print "0 " $0; next }
      { print "1 " $0 }
    ' | sort -n | cut -d" " -f2
}

find_working() {
  local domain=$1 ip
  for ip in $(collect_ips "$domain"); do
    if probe "$domain" "$ip"; then echo "$ip"; return 0; fi
  done
  return 1
}

do_revert() {
  need_root
  if grep -qF "$BEGIN" "$HOSTS"; then
    cp "$HOSTS" "${HOSTS}.bak.$(date +%Y%m%d%H%M%S)"
    sed -i '' "/${BEGIN}/,/${END}/d" "$HOSTS"
    dscacheutil -flushcache; killall -HUP mDNSResponder 2>/dev/null
    echo "Đã gỡ block Steam khỏi $HOSTS"
  else
    echo "Không tìm thấy block nào để gỡ."
  fi
}

main() {
  local check_only=${1:-}
  [[ $check_only == "--check" ]] || need_root

  local block="" found=0 failed=0
  echo
  for d in "${DOMAINS[@]}"; do
    printf "%-28s " "$d"
    if ip=$(find_working "$d"); then
      printf "%s%-16s OK%s\n" "$c_ok" "$ip" "$c_off"
      block+="${ip}	${d}"$'\n'
      ((found++))
    else
      printf "%skhông tìm được IP nào%s\n" "$c_bad" "$c_off"
      ((failed++))
    fi
  done
  echo

  if [[ $check_only == "--check" ]]; then
    echo "${c_dim}Chế độ --check: không sửa $HOSTS.${c_off}"
    [[ -n $block ]] && { echo; echo "$BEGIN"; printf '%s' "$block"; echo "$END"; }
    return
  fi

  if (( found == 0 )); then
    echo "Không domain nào truy cập được. Có thể cần VPN/WARP." >&2
    exit 1
  fi

  cp "$HOSTS" "${HOSTS}.bak.$(date +%Y%m%d%H%M%S)"
  grep -qF "$BEGIN" "$HOSTS" && sed -i '' "/${BEGIN}/,/${END}/d" "$HOSTS"
  { echo "$BEGIN"; printf '%s' "$block"; echo "$END"; } >> "$HOSTS"

  dscacheutil -flushcache; killall -HUP mDNSResponder 2>/dev/null

  echo "Đã cập nhật $HOSTS — $found domain OK, $failed thất bại."
  echo "${c_dim}Backup: ${HOSTS}.bak.*   |   Gỡ bỏ: sudo $0 --revert${c_off}"
}

case "${1:-}" in
  --revert) do_revert ;;
  --check)  main --check ;;
  "")       main ;;
  *)        echo "Dùng: sudo $0 [--check|--revert]" >&2; exit 1 ;;
esac
