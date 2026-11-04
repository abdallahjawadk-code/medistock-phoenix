import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath, URL } from 'node:url';
export default defineConfig({ root: fileURLToPath(new URL('.', import.meta.url)), plugins:[react()],
  resolve:{alias:[
    {find:'@/shared/supabase/client',replacement:fileURLToPath(new URL('./no-hosted-client.ts',import.meta.url))},
    {find:'@',replacement:fileURLToPath(new URL('../../src', import.meta.url))},
  ]},
  server:{host:'127.0.0.1',port:4197,strictPort:true,hmr:false,
    headers:{'Content-Security-Policy':"connect-src 'none'; object-src 'none'; base-uri 'none'"}},
});
