FROM node:16-alpine AS build

RUN apk update
RUN apk add --no-cache bash nano coreutils git 

RUN addgroup -S faucet && adduser -S faucet -G faucet
RUN mkdir -p /run/postgresql
RUN chown faucet:faucet /run/postgresql

WORKDIR /app
COPY . .

RUN rm -rf node_modules package-lock.json
RUN chown -R faucet:faucet .

RUN npm install

USER faucet

EXPOSE 3099

ENTRYPOINT ["node","hoosat-faucet.js","--mainnet"]