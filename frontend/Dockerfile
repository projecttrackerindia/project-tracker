FROM node:26-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
# The public address and the search-engine tokens are part of the pages the build writes (canonical links, sitemap, verification tags).
ARG SITE_URL=
ARG GOOGLE_SITE_VERIFICATION=
ARG BING_SITE_VERIFICATION=
ARG INDEXNOW_KEY=
ENV SITE_URL=$SITE_URL GOOGLE_SITE_VERIFICATION=$GOOGLE_SITE_VERIFICATION BING_SITE_VERIFICATION=$BING_SITE_VERIFICATION INDEXNOW_KEY=$INDEXNOW_KEY
RUN npm run build

FROM nginx:1.27-alpine
# A template, not the final config: nginx's own entrypoint fills in ${API_HOST} at container start (see nginx.conf).
COPY nginx.conf /etc/nginx/templates/default.conf.template
ENV API_HOST=api
# Makes the nginx entrypoint export NGINX_LOCAL_RESOLVERS (the container's DNS servers) for use in nginx.conf.
ENV NGINX_ENTRYPOINT_LOCAL_RESOLVERS=1
COPY --from=build /app/dist /usr/share/nginx/html
EXPOSE 80
