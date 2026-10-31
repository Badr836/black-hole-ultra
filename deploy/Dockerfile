# ---------------------------------------------------------------------------
#  صورة إنتاج لـ BlackHole Ultra Downloader — للنشر على استضافة دائمة
#  (Hugging Face Spaces / Render / Fly / Railway / VPS …)
#
#  تحتوي: Node 20 + ffmpeg + yt-dlp + gallery-dl، وتبني نسخة الإنتاج وتشغّلها.
#  لا تعدّل أي شيء في بنية التطبيق — نفس الكود ونفس السلوك.
# ---------------------------------------------------------------------------
FROM node:20-bookworm-slim

ENV DEBIAN_FRONTEND=noninteractive \
    NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    PORT=7860 \
    HOSTNAME=0.0.0.0

# أدوات النظام التي يعتمد عليها التطبيق فعلياً
RUN apt-get update && apt-get install -y --no-install-recommends \
      ffmpeg python3 python3-pip python3-venv ca-certificates curl aria2 \
    && rm -rf /var/lib/apt/lists/*

# محرّكات التحميل (نفس التي يعتمد عليها التطبيق محلياً)
RUN python3 -m venv /opt/yt && /opt/yt/bin/pip install --no-cache-dir -U \
      yt-dlp gallery-dl && \
    ln -sf /opt/yt/bin/yt-dlp /usr/local/bin/yt-dlp && \
    ln -sf /opt/yt/bin/gallery-dl /usr/local/bin/gallery-dl

WORKDIR /app

# الاعتماديات أولاً (طبقة قابلة للتخزين المؤقت)
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund

# ثم الكود والبناء
COPY . .
RUN npm run build

EXPOSE 7860

# مجلد البيانات (قاعدة SQLite + الملفات) — على الاستضافات المجانية قد يكون مؤقتاً
VOLUME ["/app/data"]

CMD ["npm", "start"]
