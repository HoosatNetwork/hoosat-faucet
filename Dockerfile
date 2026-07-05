# -----
FROM node:18-alpine

RUN apk add --no-cache bash nano coreutils git go

# Create non-root user
RUN addgroup -S faucet && adduser -S faucet -G faucet

RUN mkdir -p /run/postgresql && chown faucet:faucet /run/postgresql

WORKDIR /home/faucet/releases/faucet

COPY . .

RUN rm -rf node_modules package-lock.json && \
    npm install

USER faucet

EXPOSE 16110 16210 16510 16610 16111 16211 16511 16611

ENTRYPOINT ["node", "hoosat-faucet-website.js", "--mainnet"]