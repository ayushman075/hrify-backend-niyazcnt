FROM node:20-slim

WORKDIR /usr/src/app

# Install Chrome + deps (Puppeteer)
RUN apt-get update && apt-get install -y \
    wget \
    gnupg \
    fonts-liberation \
    fonts-noto \
    fonts-noto-cjk \
    libasound2 \
    libatk-bridge2.0-0 \
    libatk1.0-0 \
    libcups2 \
    libdrm2 \
    libgbm1 \
    libnspr4 \
    libnss3 \
    libxcomposite1 \
    libxdamage1 \
    libxrandr2 \
    libxss1 \
    libxtst6 \
    xdg-utils \
    --no-install-recommends \
    && wget -q -O - https://dl.google.com/linux/linux_signing_key.pub | gpg --dearmor -o /usr/share/keyrings/google.gpg \
    && echo "deb [arch=amd64 signed-by=/usr/share/keyrings/google.gpg] http://dl.google.com/linux/chrome/deb/ stable main" \
        > /etc/apt/sources.list.d/google.list \
    && apt-get update \
    && apt-get install -y google-chrome-stable \
    && rm -rf /var/lib/apt/lists/*

ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/google-chrome-stable

# Install deps
COPY package*.json ./
RUN npm ci --omit=dev

# App files
COPY . .

# Uploads folder
RUN mkdir -p public/uploads && chmod -R 777 public/uploads

# Azure listens on PORT
ENV PORT=8080
EXPOSE 8080

CMD ["node", "index.js"]
