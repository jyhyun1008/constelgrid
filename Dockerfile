# 별자리 메모보드: 2D 보드 + 북마크 정보/드라이브 파일 중계 서버
FROM node:22-alpine
WORKDIR /app
COPY index.html about.html login.html redirect.html ./
COPY assets ./assets
COPY vr ./vr
COPY server ./server
RUN mkdir -p /data && chown node:node /data
ENV PORT=8080 META_CACHE=/data/meta-cache.json
USER node
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s CMD wget -qO- http://127.0.0.1:8080/api/health || exit 1
CMD ["node", "server/server.js"]
