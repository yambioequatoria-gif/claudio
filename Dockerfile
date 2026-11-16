# One image that serves both the API and the web version of the app.

FROM node:22-alpine AS web
WORKDIR /build
COPY app/package.json app/package-lock.json ./
RUN npm ci
COPY app/ ./
# No EXPO_PUBLIC_API_URL: the web app talks to the server that serves it.
RUN npx expo export --platform web

FROM node:22-alpine AS server
WORKDIR /build
COPY server/package.json server/package-lock.json ./
RUN npm ci
COPY server/ ./
RUN npm run build && npm prune --omit=dev

FROM node:22-alpine
ENV NODE_ENV=production WEB_DIR=/srv/web PORT=3000
WORKDIR /srv/server
COPY --from=server /build/node_modules ./node_modules
COPY --from=server /build/dist ./dist
COPY --from=server /build/package.json ./
COPY server/migrations ./migrations
COPY server/questions ./questions
COPY server/public ./public
COPY --from=web /build/dist /srv/web
USER node
EXPOSE 3000
CMD ["node", "dist/index.js"]
