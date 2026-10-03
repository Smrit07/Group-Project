FROM node:20-alpine AS frontend-build

WORKDIR /app/frontend
COPY frontend/package*.json ./
RUN npm install
COPY frontend/ ./
RUN npm run build

FROM node:20-alpine

ENV NODE_ENV=production
WORKDIR /app/backend

COPY backend/package*.json ./
RUN npm install --omit=dev
COPY backend/ ./
COPY --from=frontend-build /app/frontend/dist /app/frontend/dist

EXPOSE 4000
CMD ["npm", "start"]