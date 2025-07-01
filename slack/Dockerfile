FROM node:22-slim

# Set working directory
WORKDIR /app

# Copy root package.json and lockfile if they exist
COPY package*.json ./

# Copy the specific app
COPY slack/ ./slack/

# Install dependencies from monorepo root (includes all workspace dependencies)
RUN npm ci

RUN npm run build --ws

# Expose the port your app runs on (you may need to adjust this)
EXPOSE 8080

# Start the application from root directory to maintain module resolution
CMD ["node", "/app/slack/dist/index.js"]