#!/usr/bin/env bash
# يرفع كود «بلاك هول الترا» إلى مستودع GitHub الجاهز، دون أي تعديل على كود التطبيق.
# الاستخدام:
#   GITHUB_TOKEN=ghp_xxx bash scripts/push-github.sh
# أو:
#   bash scripts/push-github.sh ghp_xxx
#
# المستودع الهدف قابل للتغيير:
#   GITHUB_REPO=Badr836/black-hole-ultra
set -euo pipefail

TOKEN="${GITHUB_TOKEN:-${1:-}}"
REPO="${GITHUB_REPO:-Badr836/black-hole-ultra}"
SRC="${SRC:-/home/user/ultra}"
BRANCH="${BRANCH:-main}"
WORK="${WORK:-/tmp/ghpush}"

if [ -z "$TOKEN" ]; then
  echo "خطأ: لا يوجد توكن. مرّر GITHUB_TOKEN أو الوسيط الأول." >&2
  exit 1
fi

AUTH_REPO="https://x-access-token:${TOKEN}@github.com/${REPO}.git"

echo "== 1/5 التحقق من صلاحية التوكن =="
WHO=$(curl -sS -H "Authorization: Bearer ${TOKEN}" -H "Accept: application/vnd.github+json" \
      https://api.github.com/user)
echo "$WHO" | grep -q '"login"' || { echo "التوكن غير صالح: $WHO" >&2; exit 1; }
echo "$WHO" | sed -n 's/.*"login": "\([^"]*\)".*/المستخدم: \1/p'

echo "== 2/5 التحقق من المستودع =="
curl -sS -H "Authorization: Bearer ${TOKEN}" -H "Accept: application/vnd.github+json" \
     "https://api.github.com/repos/${REPO}" | grep -q '"full_name"' \
  || { echo "التوكن صالح لكن لا يصل إلى ${REPO} — فعّل نطاق repo." >&2; exit 1; }
echo "المستودع متاح: ${REPO}"

echo "== 3/5 تجهيز الشجرة =="
rm -rf "$WORK"
mkdir -p "$WORK"
cd "$SRC"
# قائمة صريحة: كود التطبيق + الاستضافة فقط. لا node_modules ولا .next ولا data.
tar -cf - \
  package.json package-lock.json next.config.ts tsconfig.json postcss.config.mjs \
  eslint.config.mjs drizzle.config.json next-env.d.ts .gitignore .env.example \
  README.md START-HERE.txt AGENTS.md \
  src public deploy render.yaml scripts tests docs bin 2>/dev/null | (cd "$WORK" && tar -xf -)
# ملفات ثنائية/ضخمة لا تُرفع: أداة m3u8 المحصورة بلينكس
rm -f "$WORK/bin/N_m3u8DL-RE" 2>/dev/null || true
cat > "$WORK/.gitattributes" <<'EOF'
bin/* binary
EOF
echo "عدد الملفات: $(find "$WORK" -type f | wc -l)"
echo "الحجم: $(du -sh "$WORK" | cut -f1)"

echo "== 4/5 إنشاء الالتزام =="
cd "$WORK"
git init -q -b "$BRANCH"
git -c user.name="Badr836" -c user.email="badralhibshi@gmail.com" \
    add -A
git -c user.name="Badr836" -c user.email="badralhibshi@gmail.com" \
    commit -q -m "black-hole-ultra 1.0.0 — كود التطبيق + ملفات النشر (Dockerfile/Render)" || true
git log --oneline -1

echo "== 5/5 الدفع إلى GitHub =="
git remote add origin "$AUTH_REPO"
git push --force origin "$BRANCH"
git remote set-url origin "https://github.com/${REPO}.git"

echo
echo "تمّ. تحقّق عام بدون توكن:"
echo "  curl -s -o /dev/null -w '%{http_code}\\n' https://github.com/${REPO}"
