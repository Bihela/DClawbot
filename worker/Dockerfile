FROM ghcr.io/openclaw/openclaw:latest

USER root
WORKDIR /worker

# Install only worker deps (ioredis + aws-sqs client)
COPY package.json ./
RUN npm install --omit=dev

COPY index.js ./

# Override CMD. The entrypoint in the base image is tini -s --
ENV OPENCLAW_BOOT_COMMAND="openclaw"
USER node

CMD ["node", "index.js"]