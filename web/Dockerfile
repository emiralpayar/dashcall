FROM node:22-alpine
WORKDIR /app
COPY server.mjs ./
COPY public ./public
USER node
ENV HOST=0.0.0.0
EXPOSE 8080
CMD ["node", "server.mjs"]
