FROM node:22-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY bin ./bin
COPY src ./src
COPY web ./web
ENV A_DATA=/data PORT=8787
VOLUME /data
EXPOSE 8787
CMD ["node", "bin/a.mjs", "serve", "--port", "8787"]
