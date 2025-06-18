FROM node:20-slim

WORKDIR /usr/src/app

COPY package*.json ./

# Force update npm to the latest version
RUN npm install -g npm@latest

RUN npm install

COPY . .

EXPOSE 8080

CMD [ "npm", "start" ]
