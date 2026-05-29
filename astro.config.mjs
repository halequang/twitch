import { defineConfig } from 'astro/config';

const cleanRoutes = {
  '/skins': '/skins.html',
  '/skins2': '/skins2.html',
  '/skins3': '/skins.html',
  '/skinsOLD': '/skinsOLD.html',
  '/POE2': '/POE2.html',
  '/poe2': '/POE2.html',
};

const cleanUrlMiddleware = {
  name: 'clean-url-rewriter',
  configureServer(server) {
    server.middlewares.use((req, _res, next) => {
      if (!req.url) return next();
      const [path, query] = req.url.split('?');
      const stripped = path.replace(/\/+$/, '') || '/';
      const target = cleanRoutes[stripped];
      if (target) {
        req.url = query ? `${target}?${query}` : target;
      }
      next();
    });
  },
};

export default defineConfig({
  site: 'https://fungamingvn.shop',
  outDir: './dist',
  publicDir: './public',
  build: { format: 'file' },
  vite: {
    server: { fs: { allow: ['..'] } },
    plugins: [cleanUrlMiddleware],
  },
});
