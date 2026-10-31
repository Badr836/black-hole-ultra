#!/usr/bin/env bash
# ---------------------------------------------------------------------------
#  deploy-hf.sh — نشر BlackHole Ultra على Hugging Face Spaces (مجاناً، بلا بطاقة)
#  فيعطيك رابطاً دائماً: https://<user>-<space>.hf.space  (HTTPS ⇒ يقبل تثبيت PWA)
#
#  ما تحتاجه مرة واحدة (دقيقتان):
#    1) حساب مجاني: https://huggingface.co/join
#    2) توكن كتابة: https://huggingface.co/settings/tokens ← New token ← نوع "write"
#
#  ثم:
#    HF_TOKEN=hf_xxx HF_USER=اسم_المستخدم bash scripts/deploy-hf.sh
#    (اختياري: SPACE_NAME=blackhole-ultra)
#
#  السكربت ينشئ الـSpace (Docker) إن لم يكن موجوداً، ثم يدفع الكود عبر git.
# ---------------------------------------------------------------------------
set -uo pipefail
cd "$(dirname "$0")/.."

: "${HF_TOKEN:?مرّر HF_TOKEN (توكن كتابة من huggingface.co/settings/tokens)}"
: "${HF_USER:?مرّر HF_USER (اسم المستخدم على Hugging Face)}"
SPACE="${SPACE_NAME:-blackhole-ultra}"

say()  { printf '\n\033[1;35m▸\033[0m %s\n' "$*"; }
ok()   { printf '  \033[32m✓\033[0m %s\n' "$*"; }
fail() { printf '\n  \033[31m✗\033[0m %s\n\n' "$*"; exit 1; }

# 1) التأكد من صحة التوكن والاسم
say "التحقق من الحساب"
ME="$(curl -s -m 20 -H "Authorization: Bearer $HF_TOKEN" https://huggingface.co/api/whoami-v2 \
      | python3 -c 'import json,sys;print(json.load(sys.stdin).get("name",""))' 2>/dev/null)"
[[ -n "$ME" ]] || fail "التوكن غير صالح أو لا يملك صلاحية الوصول"
ok "الحساب: $ME"
[[ "$ME" == "$HF_USER" ]] || HF_USER="$ME"

# 2) إنشاء الـSpace إن لم existed
say "التأكيد على وجود Space باسم $SPACE"
if curl -fsS -m 20 -H "Authorization: Bearer $HF_TOKEN" \
     "https://huggingface.co/api/spaces/$HF_USER/$SPACE" >/dev/null 2>&1; then
  ok "الـSpace موجود — سأحدّثه"
else
  curl -s -m 30 -X POST https://huggingface.co/api/repos/create \
    -H "Authorization: Bearer $HF_TOKEN" -H "Content-Type: application/json" \
    -d "{\"type\":\"space\",\"name\":\"$SPACE\",\"organization\":\"\",\"private\":false,\"sdk\":\"docker\"}" \
    | head -c 300
  sleep 3
  ok "أُنشئ الـSpace"
fi

# 3) رفع الكود عبر git
say "رفع الكود (git)"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
git clone --depth 1 "https://user:$HF_TOKEN@huggingface.co/spaces/$HF_USER/$SPACE" "$WORK/repo" >/dev/null 2>&1 \
  || fail "فشل استنساخ مستودع الـSpace"

# انسخ ملفات المشروع (بلا node_modules ولا .next ولا قاعدة بيانات)
cd "$(dirname "$0")/.."
for item in src public scripts tests docs package.json package-lock.json next.config.ts \
            tsconfig.json postcss.config.mjs eslint.config.mjs drizzle.config.json next-env.d.ts; do
  [[ -e "$item" ]] && cp -a "$item" "$WORK/repo/"
done
# ملفات النشر الخاصة بالاستضافة
cp deploy/Dockerfile "$WORK/repo/Dockerfile"
cp deploy/hf-space-README.md "$WORK/repo/README.md"
printf 'node_modules\n.next\ndata/*.db\ndata/*.db-*\n' > "$WORK/repo/.gitignore"

cd "$WORK/repo"
git -c user.email="deploy@local" -c user.name="deploy" add -A >/dev/null
git -c user.email="deploy@local" -c user.name="deploy" commit -m "deploy: BlackHole Ultra" >/dev/null || ok "لا تغييرات جديدة"
git push "https://user:$HF_TOKEN@huggingface.co/spaces/$HF_USER/$SPACE" HEAD:main >/dev/null 2>&1 \
  || fail "فشل الدفع إلى Hugging Face (تحقّق من صلاحية التوكن: يجب أن يكون write)"

URL="https://$HF_USER-$SPACE.hf.space"
cat <<EOF

──────────────────────────────────────────────
  تم الرفع. Hugging Face يبني الصورة الآن (٢–٥ دقائق أول مرة).

  الرابط الدائم:
     $URL

  راقب حالة البناء:
     https://huggingface.co/spaces/$HF_USER/$SPACE

  بعد أن يصبح "Running": افتح الرابط من الجوال أو الكمبيوتر ثم
  «تثبيت التطبيق» (Chrome/Edge) أو مشاركة ← إضافة إلى الشاشة الرئيسية (Safari/iOS).
──────────────────────────────────────────────
EOF

say "فحص الوصول (قد يفشل حتى ينتهي البناء)"
for i in $(seq 1 40); do
  code="$(curl -s -o /dev/null -m 15 -w '%{http_code}' "$URL/api/health?cb=$i" || echo 000)"
  [[ "$code" == "200" ]] && { ok "التطبيق يستجيب الآن: $URL"; break; }
  sleep 15
done
