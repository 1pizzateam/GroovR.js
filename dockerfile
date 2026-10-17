FROM node:22.9.0-alpine3.20
WORKDIR /usr/src/app
# Wildcard copies both package.json and package-lock.json when available
COPY package*.json ./

RUN npm i --no-progress --loglevel=error --ignore-scripts --no-fund
CMD [ "npm", "run", "build" ]
