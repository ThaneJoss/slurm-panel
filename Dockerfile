FROM node:24-bookworm-slim

WORKDIR /app
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=5013 \
    PANEL_MODE=demo

COPY --chown=node:node package.json ./
COPY --chown=node:node src ./src
COPY --chown=node:node public ./public
COPY --chown=node:node examples ./examples

USER node
EXPOSE 5013
CMD ["node", "src/server/index.js"]
