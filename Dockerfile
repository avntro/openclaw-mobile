FROM node:22-alpine
WORKDIR /app
COPY server.js index.html manifest.json sw.js ./
COPY assets/ ./assets/
COPY icons/ ./icons/
EXPOSE 8090
CMD ["node", "server.js"]
