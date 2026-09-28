FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM nginx:1.27-alpine
# A template, not the final config: nginx's own entrypoint fills in ${API_HOST} at container start (see nginx.conf).
COPY nginx.conf /etc/nginx/templates/default.conf.template
ENV API_HOST=api
COPY --from=build /app/dist /usr/share/nginx/html
EXPOSE 80
