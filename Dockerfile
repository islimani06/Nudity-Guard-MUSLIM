FROM node:22-alpine
WORKDIR /app
COPY package.json server.js ./
ENV PORT=7000
EXPOSE 7000
CMD ["node", "server.js"]
