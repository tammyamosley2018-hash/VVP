// Bunny Video Token — Supabase Edge Function
//
// Generates a short-lived, SHA256-signed Bunny Stream embed URL server-side,
// so the token security key never reaches the browser. Without this, anyone
// with the raw embed URL could share or re-embed the video indefinitely;
// with it, every link expires and can't be forged without the secret key.
//
// Practitioner-only: requires a valid Supabase session (any logged-in
// practitioner/admin can request a token for any course video -- course
// content isn't per-practitioner scoped the way client data is).

const BUNNY_LIBRARY_ID = '714866';
const BUNNY_TOKEN_KEY = Deno.env.get('BUNNY_TOKEN_KEY');
const SUPABASE_URL = Deno.env.get('SUPABASE_URL');
if (!BUNNY_TOKEN_KEY) throw new Error('BUNNY_TOKEN_KEY is required');
if (!SUPABASE_URL) throw new Error('SUPABASE_URL is required');

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

async function sha256Hex(input: string): Promise<string> {
  const data = new TextEncoder().encode(input);
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(hashBuffer))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  try {
    const authHeader = req.headers.get('Authorization');
    if (!authHeader) {
      return new Response(JSON.stringify({ error: 'Missing Authorization header' }), {
        status: 401,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // Confirm this is a real logged-in user by asking Supabase Auth to
    // validate the token, rather than trusting the header blindly.
    const userRes = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
      headers: { Authorization: authHeader, apikey: authHeader.replace('Bearer ', '') },
    });
    if (!userRes.ok) {
      return new Response(JSON.stringify({ error: 'Invalid session' }), {
        status: 401,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const { video_id } = await req.json();
    if (!video_id || typeof video_id !== 'string') {
      return new Response(JSON.stringify({ error: 'Missing video_id' }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const expires = Math.floor(Date.now() / 1000) + 3600; // 1 hour
    const token = await sha256Hex(BUNNY_TOKEN_KEY + video_id + expires);
    const embedUrl = `https://iframe.mediadelivery.net/embed/${BUNNY_LIBRARY_ID}/${video_id}?token=${token}&expires=${expires}`;

    return new Response(JSON.stringify({ embedUrl }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: String(err) }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});
