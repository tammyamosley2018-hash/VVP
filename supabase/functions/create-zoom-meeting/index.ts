// Create Zoom Meeting — Supabase Edge Function
//
// Holds the Zoom Server-to-Server OAuth credentials server-side. Uses the
// calling practitioner's own JWT to confirm they own the client the session
// is for (RLS-scoped lookup), same pattern as send-client-message and
// bunny-video-token.
//
// This account has no reserved-time restrictions, so meetings can be
// created any time -- no time-window check needed.

import { createClient } from 'npm:@supabase/supabase-js@2';

const ZOOM_ACCOUNT_ID = Deno.env.get('ZOOM_ACCOUNT_ID');
const ZOOM_CLIENT_ID = Deno.env.get('ZOOM_CLIENT_ID');
const ZOOM_CLIENT_SECRET = Deno.env.get('ZOOM_CLIENT_SECRET');
const SUPABASE_URL = Deno.env.get('SUPABASE_URL');
if (!ZOOM_ACCOUNT_ID) throw new Error('ZOOM_ACCOUNT_ID is required');
if (!ZOOM_CLIENT_ID) throw new Error('ZOOM_CLIENT_ID is required');
if (!ZOOM_CLIENT_SECRET) throw new Error('ZOOM_CLIENT_SECRET is required');
if (!SUPABASE_URL) throw new Error('SUPABASE_URL is required');

const SUPABASE_PUBLISHABLE_KEYS_RAW = Deno.env.get('SUPABASE_PUBLISHABLE_KEYS');
const LEGACY_ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY');
const SUPABASE_PUBLISHABLE_KEYS = SUPABASE_PUBLISHABLE_KEYS_RAW
  ? JSON.parse(SUPABASE_PUBLISHABLE_KEYS_RAW)
  : null;
const PROJECT_API_KEY = SUPABASE_PUBLISHABLE_KEYS?.['default'] || LEGACY_ANON_KEY;
if (!PROJECT_API_KEY) throw new Error('Neither SUPABASE_PUBLISHABLE_KEYS nor SUPABASE_ANON_KEY is set');

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

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

    const { client_id } = await req.json();
    if (!client_id) {
      return new Response(JSON.stringify({ error: 'Missing client_id' }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const supabase = createClient(SUPABASE_URL, PROJECT_API_KEY, {
      global: { headers: { Authorization: authHeader } },
    });

    // RLS scopes this to the calling practitioner's own clients only.
    const { data: client, error: clientErr } = await supabase
      .from('clients')
      .select('id, full_name')
      .eq('id', client_id)
      .single();

    if (clientErr || !client) {
      return new Response(JSON.stringify({ error: 'Client not found or not yours' }), {
        status: 404,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const basicAuth = btoa(`${ZOOM_CLIENT_ID}:${ZOOM_CLIENT_SECRET}`);
    const tokenRes = await fetch('https://zoom.us/oauth/token', {
      method: 'POST',
      headers: {
        Authorization: `Basic ${basicAuth}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: `grant_type=account_credentials&account_id=${ZOOM_ACCOUNT_ID}`,
    });

    if (!tokenRes.ok) {
      const errText = await tokenRes.text();
      return new Response(JSON.stringify({ error: 'Zoom auth failed: ' + errText }), {
        status: 502,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const { access_token } = await tokenRes.json();

    const meetingRes = await fetch('https://api.zoom.us/v2/users/me/meetings', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${access_token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        topic: `VVP Session with ${client.full_name}`,
        type: 1, // instant meeting
        settings: {
          join_before_host: true,
          waiting_room: false,
        },
      }),
    });

    if (!meetingRes.ok) {
      const errText = await meetingRes.text();
      return new Response(JSON.stringify({ error: 'Zoom meeting creation failed: ' + errText }), {
        status: 502,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const meeting = await meetingRes.json();

    return new Response(
      JSON.stringify({ join_url: meeting.join_url, start_url: meeting.start_url, topic: meeting.topic }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  } catch (err) {
    return new Response(JSON.stringify({ error: String(err) }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});
