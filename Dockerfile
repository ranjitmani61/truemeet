# TrueMeet in a container: docker build -t truemeet . && docker run -p 3000:3000 truemeet
# No npm install step: TrueMeet has no dependencies.
FROM node:24-alpine
WORKDIR /app
COPY package.json server.js ./
COPY public ./public
ENV PORT=3000
EXPOSE 3000
USER node
CMD ["node", "server.js"]
