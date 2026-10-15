import { createClient } from '@supabase/supabase-js';

const url = process.env.SUPABASE_URL || (process.env.SUPABASE_PROJECT_ID
  ? `https://${process.env.SUPABASE_PROJECT_ID}.supabase.co`
  : '');
const secretKey = process.env.SUPABASE_SECRET_KEY;

if (!url || !secretKey) {
  throw new Error('Configure SUPABASE_URL (ou SUPABASE_PROJECT_ID) e SUPABASE_SECRET_KEY no ambiente do backend.');
}

// Chave secreta com acesso elevado. Este módulo só pode ser importado pelo servidor.
export const supabase = createClient(url, secretKey, {
  auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
});
