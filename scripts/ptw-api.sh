#!/usr/bin/env bash
# pt-watcher API 客户端：经 Cloudflare Access service token 访问部署实例。
#
# 用法:
#   scripts/ptw-api.sh [METHOD] <path> [json-body]
#   scripts/ptw-api.sh /api                                   # 接口索引
#   scripts/ptw-api.sh '/api/events?since=24h&type=completed'
#   scripts/ptw-api.sh PUT /api/settings '{"cleanDryRun":false}'
#
# 凭据来源（按顺序）:
#   1. 环境出站代理注入：Claude Code 云环境可把 Access service token 配成代理自动注入的凭据，
#      请求本身不带 token。设置了 PTW_URL 时先直接请求，没被 Access 拦截就用这个结果。
#   2. 1Password 回退：没有 PTW_URL，或直接请求被重定向到 Access 登录页且本机有 op 时，
#      用 op item get 取 token 与地址（一次取出），只保存在本进程内存，经管道交给 jq / curl
#      （-H @- 从 stdin 读请求头），不进入环境变量、命令行参数或磁盘。
#      条目字段：client_id、client_secret（按标签匹配），以及一个 URL 类型字段（实例根地址）。
#
# 可选环境变量:
#   PTW_URL        实例根地址；走代理注入时必须设置（1Password 模式下覆盖条目里的地址）
#   PTW_OP_VAULT   1Password vault，默认 Agent
#   PTW_OP_ITEM    条目名，默认 "cloudflare access - claude code"
#   PTW_NO_ACCESS  设为 1 时不用 1Password（本地开发: PTW_URL=http://localhost:3000）
#
# 退出码：0 成功；2 用法或配置错误；3 被 Cloudflare Access 拦截（重定向到登录页）；22 HTTP 错误
set -euo pipefail

method=GET
if [[ $# -ge 1 && $1 =~ ^(GET|POST|PUT|PATCH|DELETE)$ ]]; then
  method=$1
  shift
fi
if [[ $# -lt 1 ]]; then
  sed -n '2,9p' "$0" >&2
  exit 2
fi
path=$1
body=${2:-}

die() {
  echo "ptw-api: $1" >&2
  exit "${2:-2}"
}

url=${PTW_URL:-}
client_id=""
client_secret=""
load_op() {
  command -v op >/dev/null || die "找不到实例地址也没有 1Password CLI：设置 PTW_URL（代理注入凭据的环境），或安装并配置 op"
  local json
  json=$(op item get "${PTW_OP_ITEM:-cloudflare access - claude code}" --vault "${PTW_OP_VAULT:-Agent}" --format json)
  field() { printf '%s' "$json" | jq -r --arg l "$1" '[.fields[]? | select(.label == $l) | .value][0] // empty'; }
  client_id=$(field client_id)
  client_secret=$(field client_secret)
  [[ -n $client_id && -n $client_secret ]] || die "1Password 条目缺少 client_id / client_secret 字段"
  if [[ -z $url ]]; then
    url=$(printf '%s' "$json" | jq -r '[.fields[]? | select(.type == "URL") | .value][0] // .urls[0].href // empty')
  fi
}

# 末行附加 "状态码 重定向地址"，与响应体分开解析（Access 拦截时是 302 到 *.cloudflareaccess.com）
args=(-sS -X "$method" -H "Accept: application/json" -w $'\n%{http_code} %{redirect_url}')
if [[ -n $body ]]; then
  args+=(-H "Content-Type: application/json" --data-binary "$body")
fi

request() {
  if [[ -n $client_id ]]; then
    # printf 是 shell 内建命令：密钥只经管道到达 curl
    resp=$(printf 'CF-Access-Client-Id: %s\nCF-Access-Client-Secret: %s\n' "$client_id" "$client_secret" |
      curl "${args[@]}" -H @- "${url%/}$path")
  else
    resp=$(curl "${args[@]}" "${url%/}$path")
  fi
  status_line=${resp##*$'\n'}
  code=${status_line%% *}
  redirect=${status_line#* }
  resp_body=${resp%$'\n'*}
}
blocked() { [[ $code == 3* && $redirect == *cloudflareaccess.com* ]]; }

if [[ -z $url ]]; then
  [[ ${PTW_NO_ACCESS:-} != 1 ]] || die "PTW_NO_ACCESS=1 时需要设置 PTW_URL"
  load_op
  [[ -n $url ]] || die "找不到实例地址：在 1Password 条目里加一个 URL 字段，或设置 PTW_URL"
fi
request
# 直接请求被 Access 拦截（没有代理注入的凭据）时回退到 1Password；
# 拦截发生在 Access 边缘、请求没到达应用，所以写请求重试也安全
if blocked && [[ -z $client_id && ${PTW_NO_ACCESS:-} != 1 ]] && command -v op >/dev/null; then
  load_op
  request
fi
unset client_id client_secret

if blocked; then
  die "被 Cloudflare Access 拦截（HTTP $code，重定向到登录页）：环境代理没有注入 service token 且 1Password 不可用，或 token 无效 / Access 应用缺少包含该 token 的 Service Auth 策略" 3
fi
printf '%s\n' "$resp_body"
if [[ $code -ge 400 ]]; then
  die "HTTP $code" 22
fi
