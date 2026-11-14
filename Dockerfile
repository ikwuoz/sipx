FROM node:24-alpine AS builder
WORKDIR /app

COPY package.json tsconfig.base.json ./
COPY packages/protocol/package.json packages/protocol/
COPY packages/proxy/package.json packages/proxy/
COPY packages/client/package.json packages/client/

RUN npm install --ignore-scripts

COPY packages/protocol packages/protocol
COPY packages/proxy packages/proxy

RUN npm run build --workspace=@near402/protocol --workspace=near402-proxy

FROM node:24-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=4020
ENV HOST=0.0.0.0
ENV LEDGER_PATH=/data/ledger.json

COPY --from=builder /app/package.json ./package.json
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/packages/protocol/package.json ./packages/protocol/package.json
COPY --from=builder /app/packages/protocol/dist ./packages/protocol/dist
COPY --from=builder /app/packages/proxy/package.json ./packages/proxy/package.json
COPY --from=builder /app/packages/proxy/dist ./packages/proxy/dist
COPY --from=builder /app/packages/proxy/public ./packages/proxy/public

RUN mkdir -p /data
VOLUME ["/data"]
EXPOSE 4020

CMD ["node", "packages/proxy/dist/index.js"]

