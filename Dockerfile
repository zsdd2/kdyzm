FROM node:24.13.0-bookworm-slim
LABEL org.opencontainers.image.source="https://github.com/zsdd2/kdyzm" \
      org.opencontainers.image.title="kdyzm" \
      org.opencontainers.image.description="Personal parcel and pickup-code sync service" \
      org.opencontainers.image.version="3.1.50"
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY src ./src
COPY scripts/confirm-shipment-replacement.mjs ./scripts/confirm-shipment-replacement.mjs
COPY public ./public
COPY app-updates ./app-updates
COPY licenses ./licenses
COPY LICENSE ./LICENSE
RUN mkdir -p /data && chown node:node /data
USER node
ENV NODE_ENV=production HOST=0.0.0.0 PORT=8787 DATA_DIR=/data
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s CMD node -e "fetch('http://127.0.0.1:8787/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"
CMD ["node", "src/main.mjs"]
