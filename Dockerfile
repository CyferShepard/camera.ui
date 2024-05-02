FROM node:16.20.2-alpine

ARG UID="948"
ARG GID="948"

RUN apk add --no-cache ca-certificates tini python3\
 && addgroup -g "${GID}" app \
 && adduser -u "${UID}" -G app -D -h /app app


WORKDIR /app

COPY . .

# RUN ls -la
RUN npm install
RUN cd ui && npm install


RUN npm install @aws-sdk/client-rekognition @seydx/lowdb alexa-remote2 axios bunyan chalk check-disk-space commander compare-versions connect-history-api-fallback cors express ffmpeg-for-homebridge fs-extra ftp-srv get-folder-size got helmet ip jsonwebtoken lodash mailparser moment morgan mqtt multer nanoid node-telegram-bot-api nodejs-tcp-ping os pam-diff piexifjs ping pipe2pam smtp-server socket.io socketio-jwt swagger-jsdoc swagger-ui-express systeminformation tar web-push osx-temperature-sensor



USER app

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node","bin/camera.ui"]