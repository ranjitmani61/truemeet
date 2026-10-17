# Behind an HTTPS proxy: docker run -p 127.0.0.1:3000:3000 -e TRUST_PROXY=1 truemeet
# No npm install step: TrueMeet has no dependencies.
FROM node:24-alpine
WORKDIR /app
COPY package.json server.js ./
COPY public ./public
ENV PORT=3000 HOST=0.0.0.0
EXPOSE 3000
USER node
CMD ["node", "server.js"]
