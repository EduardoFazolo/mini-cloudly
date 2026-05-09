FROM node:22-alpine

RUN apk add --no-cache ffmpeg gifsicle fontconfig ttf-dejavu

WORKDIR /app

COPY package.json .
RUN npm install --omit=dev

COPY src/ ./src/

EXPOSE 4242

CMD ["node", "src/index.js"]
