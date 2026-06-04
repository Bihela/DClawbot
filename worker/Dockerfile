FROM ghcr.io/openclaw/openclaw:latest

USER root
WORKDIR /worker

# Install worker deps
COPY package.json ./
RUN npm install --omit=dev

COPY index.js ./

# Run onboarding at build time to bootstrap config files for the node user
USER node
RUN openclaw onboard --non-interactive --accept-risk --skip-health

ENV OPENCLAW_BOOT_COMMAND="openclaw crestodian"

CMD ["node", "index.js"]