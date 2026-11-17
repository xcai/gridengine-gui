FROM node:24-bookworm-slim AS base

ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
ENV npm_config_store_dir=/pnpm/store
WORKDIR /app
RUN npm install --global pnpm@10.11.0 \
    && mkdir -p /data && chown node:node /data
COPY package.json pnpm-lock.yaml ./

FROM base AS dependencies
RUN pnpm install --frozen-lockfile

FROM dependencies AS development
RUN chown -R node:node /app/node_modules /pnpm
COPY --chown=node:node . .
ENV NODE_ENV=development
USER node
EXPOSE 5173
CMD ["pnpm", "dev"]

FROM dependencies AS build
COPY . .
ARG BUILD_MODE=demo
RUN pnpm run build:${BUILD_MODE}

FROM base AS production-dependencies
RUN pnpm install --prod --frozen-lockfile

FROM base AS api
ENV NODE_ENV=production
ENV API_PORT=3101
ENV DATA_FILE=/data/data.json
ENV AUTH_FILE=/data/auth.json
COPY --from=production-dependencies /app/node_modules ./node_modules
COPY --chown=node:node server ./server
USER node
EXPOSE 3101
CMD ["node", "server/index.js"]

FROM nginx:stable-alpine AS production
COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/dist /usr/share/nginx/html
EXPOSE 80