# The whole application in one container: FeltKit (app, Studio, AppPort) on PORT and the voice runtime
# on VOICE_PORT, with FeltDB's state on a volume. `feltkit deploy` packages only the FeltKit backend and
# frontend, not the voice runtime (docs/GAPS.md, G2), so this image runs the repository's own `npm start`.
# Not yet built in CI: see docs/ACCEPTANCE.md. Set FELTKIT_AUTH_SECRET (and FELTKIT_PUBLIC_URL) at run time.
FROM node:22-slim
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
# The build needs Vite (a dev dependency); the runtime does not.
RUN npx feltkit build && npm prune --omit=dev
ENV NODE_ENV=production PORT=3000 VOICE_PORT=3001 HOST=0.0.0.0
EXPOSE 3000 3001
VOLUME ["/app/.feltkit/production"]
HEALTHCHECK --interval=15s --timeout=5s --start-period=30s CMD node -e "Promise.all([fetch('http://127.0.0.1:'+process.env.PORT+'/_feltkit/health'),fetch('http://127.0.0.1:'+process.env.VOICE_PORT+'/health')]).then(r=>process.exit(r.every(x=>x.ok)?0:1),()=>process.exit(1))"
CMD ["npm", "start"]
