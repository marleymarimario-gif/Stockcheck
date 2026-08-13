import { createClient } from "@supabase/supabase-js";

const url = import.meta.env.VITE_SUPABASE_URL ?? "";
const key = import.meta.env.VITE_SUPABASE_ANON_KEY ?? "";

export const isConfigured = url.startsWith("https://") && key.length > 20;
export const supabase = createClient(
  isConfigured ? url : "https://placeholder.supabase.co",
  isConfigured ? key : "placeholder-key",
  { auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true } },
);
