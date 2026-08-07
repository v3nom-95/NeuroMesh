FROM node:18-bullseye

WORKDIR /app

COPY package*.json ./
RUN npm install

COPY . .

# HuggingFace Spaces map port 7860
EXPOSE 7860

CMD ["node", "server.js"]
