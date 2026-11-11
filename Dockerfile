FROM node:24-bookworm-slim
WORKDIR /app
COPY --chown=node:node src ./src
COPY --chown=node:node public ./public
RUN mkdir /data && chown node:node /data
USER node
ENV HOST=0.0.0.0 PORT=3000 DB_PATH=/data/judge.sqlite
EXPOSE 3000
CMD ["node", "src/server.mjs"]
