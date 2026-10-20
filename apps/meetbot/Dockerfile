# Project Tracker's own meeting bot. Playwright's image carries Chromium, its system libraries and Xvfb: the service starts a virtual screen
# itself and runs a real, non-headless browser on it (Google Meet treats it like any guest); without one it falls back to headless.
FROM mcr.microsoft.com/playwright:v1.64.0-noble
WORKDIR /app
ENV NODE_ENV=production PORT=8080 MEETBOT_HEADLESS=false
# Whisper (faster-whisper, CPU, int8) transcribes each call's audio after it ends; the model is fetched at build time so calls never wait.
ARG WHISPER_MODEL=small
RUN apt-get update && apt-get install -y --no-install-recommends python3 python3-venv && rm -rf /var/lib/apt/lists/*
RUN python3 -m venv /opt/whisper-env && /opt/whisper-env/bin/pip install --no-cache-dir faster-whisper==1.1.1
# Fetch the model now so calls never wait; if the download is unavailable here it is fetched on the first call instead.
RUN mkdir -p /opt/whisper && (HF_HOME=/opt/whisper /opt/whisper-env/bin/python -c "from faster_whisper import WhisperModel; WhisperModel('${WHISPER_MODEL}', device='cpu', compute_type='int8')" \
      || echo "whisper model not prefetched") && chmod -R a+rwX /opt/whisper
ENV HF_HOME=/opt/whisper MEETBOT_WHISPER_MODEL=${WHISPER_MODEL} MEETBOT_PYTHON=/opt/whisper-env/bin/python
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund
COPY src ./src
# The virtual screen's socket directory must exist before the service drops to an ordinary user (Xvfb cannot create it then).
RUN mkdir -p /tmp/.X11-unix && chmod 1777 /tmp/.X11-unix
USER pwuser
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "src/server.mjs"]
