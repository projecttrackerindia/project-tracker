FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM nginx:1.31-alpine
# A template, not the final config: nginx's own entrypoint fills in ${API_HOST} at container start (see nginx.conf).
COPY nginx.conf /etc/nginx/templates/default.conf.template
ENV API_HOST=api
# Makes the nginx entrypoint export NGINX_LOCAL_RESOLVERS (the container's DNS servers) for use in nginx.conf.
ENV NGINX_ENTRYPOINT_LOCAL_RESOLVERS=1
COPY --from=build /app/dist /usr/share/nginx/html
EXPOSE 80
