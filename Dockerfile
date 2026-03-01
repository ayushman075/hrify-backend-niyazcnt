# Use a compatible Node.js version
FROM node:20-slim

# Set a working directory inside the container
WORKDIR /usr/src/app

# Install Google Chrome and its dependencies
RUN apt-get update && apt-get install -y \
    wget \
    gnupg \
    && wget -q -O - https://dl.google.com/linux/linux_signing_key.pub | apt-key add - \
    && sh -c 'echo "deb [arch=amd64] http://dl.google.com/linux/chrome/deb/ stable main" >> /etc/apt/sources.list.d/google-chrome.list' \
    && apt-get update \
    && apt-get install -y google-chrome-stable \
    && rm -rf /var/lib/apt/lists/*

# Install additional dependencies for Puppeteer
RUN apt-get update && apt-get install -y \
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
    && rm -rf /var/lib/apt/lists/*

# Install application dependencies
COPY package*.json ./
RUN npm install

ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/google-chrome-stable

# Create the directory with the correct permissions
RUN mkdir -p /usr/src/app/public/uploads && chmod -R 777 /usr/src/app/public/uploads

COPY package*.json ./
RUN npm ci
COPY . .

# Ensure the copied files have the correct permissions
RUN chmod -R 777 /usr/src/app/public/uploads
EXPOSE 8080
CMD ["node", "index.js"]
