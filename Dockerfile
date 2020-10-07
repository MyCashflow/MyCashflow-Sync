FROM node:12 AS frontend

RUN apt-get update -y && apt-get install -y --no-install-recommends \
    bzip2 \
    fontconfig

COPY . /src

WORKDIR /src

RUN npm link

WORKDIR /app

EXPOSE 3000
EXPOSE 3001

ENTRYPOINT ["mycashflow-sync"]
