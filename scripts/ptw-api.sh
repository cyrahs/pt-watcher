#!/usr/bin/env bash
# pt-watcher API 客户端：经 Cloudflare Access service token 访问部署实例。
#
# 用法:
#   scripts/ptw-api.sh [METHOD] <path> [json-body]
#   scripts/ptw-api.sh /api                                   # 接口索引
#   scripts/ptw-api.sh '/api/events?since=24h&type=completed'
#   scripts/ptw-api.sh PUT /api/settings '{"cleanDryRun":false}'
#
# service token 在运行时用 1Password CLI（op）读取，只存在于本进程内存，经 stdin 传给 curl，
# 不进入环境变量、命令行参数或磁盘。
#
# 环境变量:
#   PTW_OP_ITEM    1Password 条目引用，默认 op://pt-watcher/cloudflare-access
#                  字段: client_id / client_secret；url（可选，PTW_URL 未设置时读取）
#   PTW_URL        实例根地址，如 https://ptw.example.com
#   PTW_NO_ACCESS  设为 1 时不带 service token（本地开发: PTW_URL=http://localhost:3000）
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

item=${PTW_OP_ITEM:-op://pt-watcher/cloudflare-access}
url=${PTW_URL:-}
if [[ -z $url ]]; then
  url=$(op read -n "$item/url")
fi

args=(-sS --fail-with-body -X "$method" -H "Accept: application/json")
if [[ -n $body ]]; then
  args+=(-H "Content-Type: application/json" --data-binary "$body")
fi

if [[ ${PTW_NO_ACCESS:-} == 1 ]]; then
  curl "${args[@]}" "${url%/}$path"
else
  client_id=$(op read -n "$item/client_id")
  client_secret=$(op read -n "$item/client_secret")
  # printf 是 shell 内建命令：密钥只经管道到达 curl（-H @- 从 stdin 读请求头）
  printf 'CF-Access-Client-Id: %s\nCF-Access-Client-Secret: %s\n' "$client_id" "$client_secret" |
    curl "${args[@]}" -H @- "${url%/}$path"
fi
echo
