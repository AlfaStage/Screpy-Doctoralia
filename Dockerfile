FROM node:22-slim

# Install Chrome and dependencies (including curl for proxy testing)
RUN apt-get update \
  && apt-get install -y wget gnupg curl \
  && wget -q -O - https://dl-ssl.google.com/linux/linux_signing_key.pub | gpg --dearmor -o /usr/share/keyrings/googlechrome-linux-keyring.gpg \
  && sh -c 'echo "deb [arch=amd64 signed-by=/usr/share/keyrings/googlechrome-linux-keyring.gpg] http://dl.google.com/linux/chrome/deb/ stable main" >> /etc/apt/sources.list.d/google.list' \
  && apt-get update \
  && apt-get install -y google-chrome-stable fonts-ipafont-gothic fonts-wqy-zenhei fonts-thai-tlwg fonts-kacst fonts-freefont-ttf libxss1 dumb-init \
  --no-install-recommends \
  && rm -rf /var/lib/apt/lists/*

# Create app directory
WORKDIR /usr/src/app

# Copy package.json and package-lock.json (if available)
COPY package*.json ./

# Skip Puppeteer's bundled Chromium download (we use system Chrome)
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true
# Point Puppeteer to system Chrome
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/google-chrome-stable

# Install dependencies
RUN npm config set fetch-retry-maxtimeout 600000 \
  && npm config set fetch-retry-mintimeout 10000 \
  && npm install --verbose --ignore-scripts

# Copy the rest of the application source code
COPY . .

# Create results and data directories
RUN mkdir -p results data

# Expose the port the app runs on
EXPOSE 3000

# Use dumb-init for proper signal handling
ENTRYPOINT ["dumb-init", "--"]

# Define the command to run the app
CMD ["node", "server.js"]
