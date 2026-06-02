FROM node:22-alpine
# Install build dependencies for compilation of native libraries (e.g. SQLite if needed)
RUN apk add --no-cache python3 make g++ git

WORKDIR /app
COPY package*.json ./
RUN npm install --omit=dev
COPY index.js ./
CMD ["npm", "start"]
